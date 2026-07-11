(function () {
    'use strict';

    const MODEL_MANIFEST = 'assets/captcha-cnn-model.json';
    let modelPromise = null;

    function tensor(weights, descriptor) {
        return weights.subarray(descriptor.offset, descriptor.offset + descriptor.length);
    }

    async function loadModel() {
        if (modelPromise) return modelPromise;
        modelPromise = (async () => {
            const manifestUrl = chrome.runtime.getURL(MODEL_MANIFEST);
            const manifestResponse = await fetch(manifestUrl, { cache: 'force-cache' });
            if (!manifestResponse.ok) {
                throw new Error(`CNN manifest unavailable: ${manifestResponse.status}`);
            }
            const manifest = await manifestResponse.json();
            const weightsUrl = new URL(manifest.weights, manifestUrl).href;
            const weightsResponse = await fetch(weightsUrl, { cache: 'force-cache' });
            if (!weightsResponse.ok) {
                throw new Error(`CNN weights unavailable: ${weightsResponse.status}`);
            }
            const weights = new Float32Array(await weightsResponse.arrayBuffer());
            if (weights.length !== manifest.floatCount) {
                throw new Error(`CNN weight length mismatch: ${weights.length} != ${manifest.floatCount}`);
            }
            return { manifest, weights };
        })().catch(error => {
            modelPromise = null;
            throw error;
        });
        return modelPromise;
    }

    function conv3x3(input, inChannels, height, width, weight, bias, outChannels) {
        const output = new Float32Array(outChannels * height * width);
        const plane = height * width;
        for (let outChannel = 0; outChannel < outChannels; outChannel++) {
            const outputOffset = outChannel * plane;
            const initial = bias[outChannel];
            if (initial !== 0) output.fill(initial, outputOffset, outputOffset + plane);
            for (let inChannel = 0; inChannel < inChannels; inChannel++) {
                const inputOffset = inChannel * plane;
                const kernelOffset = (outChannel * inChannels + inChannel) * 9;
                for (let kernelY = 0; kernelY < 3; kernelY++) {
                    const yStart = kernelY === 0 ? 1 : 0;
                    const yEnd = kernelY === 2 ? height - 1 : height;
                    for (let kernelX = 0; kernelX < 3; kernelX++) {
                        const coefficient = weight[kernelOffset + kernelY * 3 + kernelX];
                        if (coefficient === 0) continue;
                        const xStart = kernelX === 0 ? 1 : 0;
                        const xEnd = kernelX === 2 ? width - 1 : width;
                        const yShift = kernelY - 1;
                        const xShift = kernelX - 1;
                        for (let y = yStart; y < yEnd; y++) {
                            const inputRow = inputOffset + (y + yShift) * width;
                            const outputRow = outputOffset + y * width;
                            for (let x = xStart; x < xEnd; x++) {
                                output[outputRow + x] += input[inputRow + x + xShift] * coefficient;
                            }
                        }
                    }
                }
            }
        }
        return output;
    }

    function relu(values) {
        for (let index = 0; index < values.length; index++) {
            if (values[index] < 0) values[index] = 0;
        }
        return values;
    }

    function maxPool2x2(input, channels, height, width) {
        const outputHeight = Math.floor(height / 2);
        const outputWidth = Math.floor(width / 2);
        const inputPlane = height * width;
        const outputPlane = outputHeight * outputWidth;
        const output = new Float32Array(channels * outputPlane);
        for (let channel = 0; channel < channels; channel++) {
            const inputOffset = channel * inputPlane;
            const outputOffset = channel * outputPlane;
            for (let y = 0; y < outputHeight; y++) {
                const row0 = inputOffset + y * 2 * width;
                const row1 = row0 + width;
                const outputRow = outputOffset + y * outputWidth;
                for (let x = 0; x < outputWidth; x++) {
                    const source = x * 2;
                    output[outputRow + x] = Math.max(
                        input[row0 + source],
                        input[row0 + source + 1],
                        input[row1 + source],
                        input[row1 + source + 1]
                    );
                }
            }
        }
        return output;
    }

    function linear(input, weight, bias, outputSize) {
        const output = new Float32Array(outputSize);
        for (let row = 0; row < outputSize; row++) {
            let value = bias[row];
            const offset = row * input.length;
            for (let column = 0; column < input.length; column++) {
                value += input[column] * weight[offset + column];
            }
            output[row] = value;
        }
        return output;
    }

    function classify(input, model) {
        const { manifest, weights } = model;
        const descriptors = manifest.tensors;
        const get = name => tensor(weights, descriptors[name]);

        let values = conv3x3(input, 3, 32, 24, get('conv1.weight'), get('conv1.bias'), 24);
        values = maxPool2x2(relu(values), 24, 32, 24);
        values = conv3x3(values, 24, 16, 12, get('conv2.weight'), get('conv2.bias'), 48);
        values = maxPool2x2(relu(values), 48, 16, 12);
        values = relu(conv3x3(values, 48, 8, 6, get('conv3.weight'), get('conv3.bias'), 64));
        values = relu(linear(values, get('fc1.weight'), get('fc1.bias'), 128));
        const logits = linear(values, get('fc2.weight'), get('fc2.bias'), manifest.charset.length);

        let maxLogit = -Infinity;
        for (const value of logits) maxLogit = Math.max(maxLogit, value);
        const probabilities = new Float32Array(logits.length);
        let total = 0;
        for (let index = 0; index < logits.length; index++) {
            const probability = Math.exp(logits[index] - maxLogit);
            probabilities[index] = probability;
            total += probability;
        }
        const ranked = Array.from(probabilities, (value, index) => ({
            label: manifest.charset[index],
            probability: value / total
        })).sort((left, right) => right.probability - left.probability);
        return {
            label: ranked[0].label,
            confidence: ranked[0].probability,
            top3: ranked.slice(0, 3)
        };
    }

    function readSlot(baseCanvas, position) {
        const overlap = 3;
        const sourceX = Math.max(0, position * 20 - overlap);
        const sourceRight = Math.min(80, (position + 1) * 20 + overlap);
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 32;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(
            baseCanvas,
            sourceX, 0, sourceRight - sourceX, 30,
            0, 0, 24, 32
        );
        const pixels = context.getImageData(0, 0, 24, 32).data;
        const input = new Float32Array(3 * 32 * 24);
        const plane = 32 * 24;
        for (let pixel = 0; pixel < plane; pixel++) {
            const source = pixel * 4;
            input[pixel] = pixels[source] / 255;
            input[plane + pixel] = pixels[source + 1] / 255;
            input[plane * 2 + pixel] = pixels[source + 2] / 255;
        }
        return input;
    }

    function normalizeImage(imgElement) {
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 30;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(imgElement, 0, 0, 80, 30);
        return canvas;
    }

    async function recognize(imgElement) {
        const started = performance.now();
        const model = await loadModel();
        const baseCanvas = normalizeImage(imgElement);
        const chars = [];
        for (let position = 0; position < 4; position++) {
            chars.push(classify(readSlot(baseCanvas, position), model));
        }
        return {
            code: chars.map(item => item.label).join(''),
            chars,
            elapsedMs: performance.now() - started
        };
    }

    window.NjuCaptchaCnn = {
        loadModel,
        recognize
    };
})();

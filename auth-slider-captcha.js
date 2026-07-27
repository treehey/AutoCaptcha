// Browser-native adapter for the current NJU authserver slider challenge.
// It intentionally keeps page-specific transport and image processing here so
// the login controller only needs to handle high-level authentication states.
(function initNjuAuthSliderCaptcha(global) {
    'use strict';

    const AUTH_PATH = '/authserver';
    const SLIDER_WIDTH = 280;
    const BACKGROUND_DRAW_WIDTH = 278;
    const MAX_MOVE_LENGTH = 240;
    const DEFAULT_ATTEMPTS = 3;
    const MIN_VERIFY_DELAY_MS = 1700;
    const MAX_VERIFY_DELAY_MS = 1820;
    const MIN_MATCH_SCORE = 0.12;
    const MIN_MATCH_MARGIN = 0.008;
    const RANDOM_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

    class SliderCaptchaError extends Error {
        constructor(message, cause) {
            super(message);
            this.name = 'SliderCaptchaError';
            this.cause = cause;
        }
    }

    function randomInt(maxExclusive) {
        if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
            throw new SliderCaptchaError('Invalid random range');
        }
        const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
        const values = new Uint32Array(1);
        do {
            global.crypto.getRandomValues(values);
        } while (values[0] >= limit);
        return values[0] % maxExclusive;
    }

    function randomString(length) {
        let value = '';
        for (let index = 0; index < length; index++) {
            value += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
        }
        return value;
    }

    function base64ToBytes(value, name) {
        if (typeof value !== 'string' || !value) {
            throw new SliderCaptchaError(`Slider response is missing ${name}`);
        }
        try {
            const binary = global.atob(value);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
            return bytes;
        } catch (error) {
            throw new SliderCaptchaError(`Slider ${name} is not valid Base64`, error);
        }
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return global.btoa(binary);
    }

    function utf8Bytes(value) {
        return new TextEncoder().encode(value);
    }

    function concatBytes(...parts) {
        const length = parts.reduce((total, part) => total + part.length, 0);
        const output = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            output.set(part, offset);
            offset += part.length;
        }
        return output;
    }

    async function encryptForPage(value, keyText) {
        const key = utf8Bytes(keyText);
        if (key.length !== 16) {
            throw new SliderCaptchaError('Slider key must be 16 bytes');
        }
        const iv = utf8Bytes(randomString(16));
        const plain = utf8Bytes(`${randomString(64)}${value}`);
        const cryptoKey = await global.crypto.subtle.importKey(
            'raw',
            key,
            { name: 'AES-CBC' },
            false,
            ['encrypt']
        );
        const encrypted = await global.crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            cryptoKey,
            // WebCrypto AES-CBC performs the same PKCS#7 padding as the page's CryptoJS call.
            plain
        );
        return bytesToBase64(new Uint8Array(encrypted));
    }

    function parseChallengePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new SliderCaptchaError('Slider endpoint did not return an object');
        }
        const backgroundBytes = base64ToBytes(payload.bigImage, 'background image');
        const pieceWithKey = base64ToBytes(payload.smallImage, 'piece image');
        if (pieceWithKey.length <= 16) {
            throw new SliderCaptchaError('Slider piece does not contain a key suffix');
        }
        const keyBytes = pieceWithKey.slice(-16);
        const pieceBytes = pieceWithKey.slice(0, -16);
        const key = new TextDecoder('ascii', { fatal: true }).decode(keyBytes);
        return { backgroundBytes, pieceBytes, key };
    }

    function canvasForImage(width, height) {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
        const canvas = global.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    async function decodeImage(bytes, name) {
        const blob = new Blob([bytes], { type: 'image/png' });
        if (typeof global.createImageBitmap === 'function') {
            const bitmap = await global.createImageBitmap(blob);
            const canvas = canvasForImage(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(bitmap, 0, 0);
            bitmap.close?.();
            return context.getImageData(0, 0, canvas.width, canvas.height);
        }

        return await new Promise((resolve, reject) => {
            const objectUrl = global.URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
                try {
                    const canvas = canvasForImage(image.naturalWidth, image.naturalHeight);
                    const context = canvas.getContext('2d', { willReadFrequently: true });
                    context.drawImage(image, 0, 0);
                    resolve(context.getImageData(0, 0, canvas.width, canvas.height));
                } catch (error) {
                    reject(new SliderCaptchaError(`Unable to decode slider ${name}`, error));
                } finally {
                    global.URL.revokeObjectURL(objectUrl);
                }
            };
            image.onerror = () => {
                global.URL.revokeObjectURL(objectUrl);
                reject(new SliderCaptchaError(`Unable to decode slider ${name}`));
            };
            image.src = objectUrl;
        });
    }

    function grayscale(image) {
        const output = new Uint8Array(image.width * image.height);
        for (let pixel = 0, offset = 0; pixel < output.length; pixel++, offset += 4) {
            output[pixel] = Math.round(
                image.data[offset] * 0.299
                + image.data[offset + 1] * 0.587
                + image.data[offset + 2] * 0.114
            );
        }
        return output;
    }

    function findVisibleBounds(image) {
        let left = image.width;
        let top = image.height;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
                if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < left || bottom < top) {
            throw new SliderCaptchaError('Slider piece is fully transparent');
        }
        return { left, top, width: right - left + 1, height: bottom - top + 1 };
    }

    function cannyEdges(gray, width, height, lowThreshold = 50, highThreshold = 150) {
        const size = width * height;
        const magnitude = new Float32Array(size);
        const direction = new Uint8Array(size);
        const suppressed = new Float32Array(size);
        const edges = new Uint8Array(size);

        for (let y = 1; y < height - 1; y++) {
            const row = y * width;
            for (let x = 1; x < width - 1; x++) {
                const index = row + x;
                const topLeft = gray[index - width - 1];
                const top = gray[index - width];
                const topRight = gray[index - width + 1];
                const middleLeft = gray[index - 1];
                const middleRight = gray[index + 1];
                const bottomLeft = gray[index + width - 1];
                const bottom = gray[index + width];
                const bottomRight = gray[index + width + 1];
                const horizontal = -topLeft - 2 * middleLeft - bottomLeft + topRight + 2 * middleRight + bottomRight;
                const vertical = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
                // OpenCV's Canny defaults to the L1 gradient norm unless L2gradient
                // is explicitly requested. Match that behavior for stable scores.
                magnitude[index] = Math.abs(horizontal) + Math.abs(vertical);
                const angle = (Math.atan2(vertical, horizontal) * 180 / Math.PI + 180) % 180;
                direction[index] = angle < 22.5 || angle >= 157.5 ? 0
                    : angle < 67.5 ? 1
                        : angle < 112.5 ? 2 : 3;
            }
        }

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const index = y * width + x;
                const current = magnitude[index];
                let first = 0;
                let second = 0;
                if (direction[index] === 0) {
                    first = magnitude[index - 1];
                    second = magnitude[index + 1];
                } else if (direction[index] === 1) {
                    first = magnitude[index - width + 1];
                    second = magnitude[index + width - 1];
                } else if (direction[index] === 2) {
                    first = magnitude[index - width];
                    second = magnitude[index + width];
                } else {
                    first = magnitude[index - width - 1];
                    second = magnitude[index + width + 1];
                }
                if (current >= first && current >= second) suppressed[index] = current;
            }
        }

        const pending = [];
        for (let index = 0; index < size; index++) {
            if (suppressed[index] >= highThreshold) {
                edges[index] = 255;
                pending.push(index);
            } else if (suppressed[index] >= lowThreshold) {
                edges[index] = 128;
            }
        }
        while (pending.length) {
            const index = pending.pop();
            const x = index % width;
            const y = Math.floor(index / width);
            for (let offsetY = -1; offsetY <= 1; offsetY++) {
                for (let offsetX = -1; offsetX <= 1; offsetX++) {
                    if (!offsetX && !offsetY) continue;
                    const nextX = x + offsetX;
                    const nextY = y + offsetY;
                    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
                    const next = nextY * width + nextX;
                    if (edges[next] === 128) {
                        edges[next] = 255;
                        pending.push(next);
                    }
                }
            }
        }
        for (let index = 0; index < size; index++) {
            if (edges[index] !== 255) edges[index] = 0;
        }
        return edges;
    }

    function cropImage(image, bounds) {
        const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);
        for (let y = 0; y < bounds.height; y++) {
            const sourceStart = ((bounds.top + y) * image.width + bounds.left) * 4;
            const targetStart = y * bounds.width * 4;
            data.set(image.data.subarray(sourceStart, sourceStart + bounds.width * 4), targetStart);
        }
        return { width: bounds.width, height: bounds.height, data };
    }

    function correlationAt(template, templateWidth, background, backgroundWidth, left, top) {
        const templateHeight = Math.floor(template.length / templateWidth);
        const count = template.length;
        let sumTemplate = 0;
        let sumBackground = 0;
        let sumTemplateSquared = 0;
        let sumBackgroundSquared = 0;
        let sumProduct = 0;
        for (let y = 0; y < templateHeight; y++) {
            const templateRow = y * templateWidth;
            const backgroundRow = (top + y) * backgroundWidth + left;
            for (let x = 0; x < templateWidth; x++) {
                const first = template[templateRow + x];
                const second = background[backgroundRow + x];
                sumTemplate += first;
                sumBackground += second;
                sumTemplateSquared += first * first;
                sumBackgroundSquared += second * second;
                sumProduct += first * second;
            }
        }
        const numerator = sumProduct - sumTemplate * sumBackground / count;
        const denominator = Math.sqrt(
            Math.max(0, sumTemplateSquared - sumTemplate * sumTemplate / count)
            * Math.max(0, sumBackgroundSquared - sumBackground * sumBackground / count)
        );
        return denominator > 0 ? numerator / denominator : -1;
    }

    function locateGapFromImageData(background, piece) {
        const bounds = findVisibleBounds(piece);
        if (bounds.top + bounds.height > background.height || bounds.width > background.width) {
            throw new SliderCaptchaError('Slider piece dimensions do not match the background');
        }

        const backgroundEdges = cannyEdges(grayscale(background), background.width, background.height);
        // Keep the processing order identical to the OpenCV reference: crop the
        // visible puzzle piece first, then calculate its edge map.
        const templateImage = cropImage(piece, bounds);
        const template = cannyEdges(grayscale(templateImage), templateImage.width, templateImage.height);

        let left = -1;
        let confidence = -Infinity;
        const scores = [];
        const maximumLeft = background.width - bounds.width;
        for (let candidate = 0; candidate <= maximumLeft; candidate++) {
            const score = correlationAt(template, bounds.width, backgroundEdges, background.width, candidate, bounds.top);
            scores.push(score);
            if (score > confidence) {
                confidence = score;
                left = candidate;
            }
        }
        if (left < 0 || !Number.isFinite(confidence)) {
            throw new SliderCaptchaError('Unable to locate slider gap');
        }

        let secondBest = -Infinity;
        for (let candidate = 0; candidate < scores.length; candidate++) {
            if (Math.abs(candidate - left) < 8) continue;
            secondBest = Math.max(secondBest, scores[candidate]);
        }
        const margin = Number.isFinite(secondBest) ? confidence - secondBest : confidence;
        const moveLength = Math.floor(left * BACKGROUND_DRAW_WIDTH / background.width + 0.5) + 2;
        if (!(moveLength > 0 && moveLength <= MAX_MOVE_LENGTH)) {
            throw new SliderCaptchaError(`Slider distance is out of range: ${moveLength}`);
        }
        return {
            left,
            confidence,
            margin,
            moveLength,
            pieceBounds: bounds,
            backgroundWidth: background.width
        };
    }

    function generateTracks(moveLength) {
        const profile = [0.0667, 0.122, 0.211, 0.367, 0.5, 0.622, 0.733, 0.778, 0.822, 0.867, 0.889, 0.911, 0.944, 0.967, 1];
        let vertical = [-1, 0, 1][randomInt(3)];
        const tracks = [
            { a: 0, b: 0, c: 0 },
            { a: 0, b: [-1, 0, 0, 1][randomInt(4)], c: 28 + randomInt(21) }
        ];
        let previous = 0;
        for (const proportion of profile) {
            const jitter = proportion < 1 ? (randomInt(1601) - 800) / 100000 : 0;
            const position = Math.min(moveLength, Math.max(previous, Math.floor(moveLength * (proportion + jitter) + 0.5)));
            if (position - previous < 2 && proportion < 1) continue;
            if (randomInt(100) < 18) vertical = Math.max(-2, Math.min(2, vertical + [-1, 0, 1][randomInt(3)]));
            tracks.push({ a: position, b: vertical, c: 21 + randomInt(16) });
            previous = position;
        }
        if (tracks[tracks.length - 1].a !== moveLength) {
            tracks.push({ a: moveLength, b: vertical, c: 45 + randomInt(46) });
        } else {
            tracks[tracks.length - 1].c = 45 + randomInt(46);
        }
        tracks.push({ a: moveLength, b: vertical, c: 220 + randomInt(171) });
        return tracks;
    }

    function pause(milliseconds) {
        return new Promise(resolve => global.setTimeout(resolve, milliseconds));
    }

    function authUrl(path) {
        return new URL(path, global.location?.origin || 'https://authserver.nju.edu.cn').href;
    }

    async function ensureOk(response, action) {
        if (!response || !response.ok) {
            throw new SliderCaptchaError(`${action} failed with HTTP ${response?.status || 'unknown'}`);
        }
        return response;
    }

    async function solve(options = {}) {
        const fetchImpl = options.fetchImpl || global.fetch.bind(global);
        const sleep = options.sleep || pause;
        const now = options.now || (() => global.performance.now());
        const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => { };
        const attempts = Math.max(1, Math.min(options.attempts || DEFAULT_ATTEMPTS, 5));
        const minScore = options.minScore ?? MIN_MATCH_SCORE;
        const minMargin = options.minMargin ?? MIN_MATCH_MARGIN;
        const headers = { 'X-Requested-With': 'XMLHttpRequest' };
        let lastError = null;
        let lastMatch = null;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                onStatus({ phase: 'opening', attempt, attempts });
                await ensureOk(await fetchImpl(authUrl(`${AUTH_PATH}/common/toSliderCaptcha.htl`), {
                    method: 'GET', credentials: 'include', headers
                }), 'Opening slider challenge');
                const openedAt = now();
                const response = await ensureOk(await fetchImpl(authUrl(`${AUTH_PATH}/common/openSliderCaptcha.htl?_=${Date.now()}`), {
                    method: 'GET', credentials: 'include', headers
                }), 'Loading slider challenge');
                const payload = await response.json();
                const { backgroundBytes, pieceBytes, key } = parseChallengePayload(payload);
                onStatus({ phase: 'matching', attempt, attempts });
                const [background, piece] = await Promise.all([
                    decodeImage(backgroundBytes, 'background'),
                    decodeImage(pieceBytes, 'piece')
                ]);
                const match = locateGapFromImageData(background, piece);
                lastMatch = match;
                if (match.confidence < minScore || match.margin < minMargin) {
                    throw new SliderCaptchaError(
                        `Uncertain slider match (score ${match.confidence.toFixed(3)}, margin ${match.margin.toFixed(3)})`
                    );
                }

                const proof = {
                    canvasLength: SLIDER_WIDTH,
                    moveLength: match.moveLength,
                    tracks: generateTracks(match.moveLength)
                };
                const desiredDelay = MIN_VERIFY_DELAY_MS + randomInt(MAX_VERIFY_DELAY_MS - MIN_VERIFY_DELAY_MS + 1);
                const remaining = desiredDelay - (now() - openedAt);
                if (remaining > 0) await sleep(remaining);
                const sign = await encryptForPage(JSON.stringify(proof), key);
                onStatus({ phase: 'verifying', attempt, attempts, match });
                const verification = await ensureOk(await fetchImpl(authUrl(`${AUTH_PATH}/common/verifySliderCaptcha.htl`), {
                    method: 'POST',
                    credentials: 'include',
                    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ sign }).toString()
                }), 'Verifying slider challenge');
                const result = await verification.json();
                if (String(result?.errorCode) === '1') {
                    return { ok: true, attempt, attempts, match, proof };
                }
                lastError = new SliderCaptchaError('Slider verification was rejected');
            } catch (error) {
                lastError = error instanceof SliderCaptchaError
                    ? error
                    : new SliderCaptchaError('Slider verification failed', error);
            }
        }
        return {
            ok: false,
            error: lastError?.message || 'Slider verification failed',
            match: lastMatch
        };
    }

    global.NjuAuthSliderCaptcha = Object.freeze({
        solve,
        encryptForPage,
        locateGapFromImageData,
        parseChallengePayload,
        __test: Object.freeze({
            cannyEdges,
            generateTracks,
            bytesToBase64
        })
    });
})(typeof globalThis !== 'undefined' ? globalThis : window);

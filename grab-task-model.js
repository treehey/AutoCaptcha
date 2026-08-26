(function initNjuGrabTaskModel(global) {
  'use strict';

  const STORAGE_KEY = 'nju_grab_task_v1';
  const SCHEMA_VERSION = 4;
  const MAX_GROUPS = 100;
  const MAX_TARGETS = 100;
  const MIN_PRIORITY = -1000;
  const MAX_PRIORITY = 1000;
  const TARGET_KIND = Object.freeze({
    KEYWORD: 'KEYWORD',
    TEACHING_CLASS: 'TEACHING_CLASS'
  });

  function boundedText(value, maxLength = 200) {
    return String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function identityPart(value) {
    return encodeURIComponent(boundedText(value, 300) || '-');
  }

  function normalizeTargetFilters(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const filters = {
      teacher: boundedText(source.teacher || source.teacherFilter, 200),
      time: boundedText(source.time || source.timeFilter, 300),
      campus: boundedText(source.campus || source.campusFilter, 100)
    };
    return Object.freeze(Object.fromEntries(Object.entries(filters).filter(([, item]) => item !== '')));
  }

  function keywordId(name, filters = {}) {
    const base = `keyword:${identityPart(boundedText(name).toLocaleLowerCase())}`;
    if (Object.keys(filters).length === 0) return base;
    return [
      base,
      'filter',
      identityPart(filters.teacher),
      identityPart(filters.time),
      identityPart(filters.campus)
    ].join(':');
  }

  function teachingClassId(value) {
    return [
      'class',
      identityPart(value.electiveBatchId),
      identityPart(value.teachingClassType),
      identityPart(value.teachingClassId)
    ].join(':');
  }

  function normalizePriority(value) {
    const priority = Number(value);
    if (!Number.isFinite(priority)) return 0;
    return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(priority)));
  }

  function targetLabel(target) {
    if (!target) return '';
    if (target.kind === TARGET_KIND.KEYWORD) {
      const filters = target.filters || {};
      const details = [
        filters.teacher ? `教师 ${filters.teacher}` : '',
        filters.time ? `时间 ${filters.time}` : '',
        filters.campus ? `校区 ${filters.campus}` : ''
      ].filter(Boolean);
      return [target.name, ...details].join(' · ');
    }
    const details = [
      target.teacher,
      target.teachingClassNo || target.teachingClassId,
      target.courseNumber,
      target.campus,
      target.time
    ].filter(Boolean);
    return [target.name || '教学班', ...details].join(' · ');
  }

  function normalizeTarget(value) {
    if (typeof value === 'string') {
      const name = boundedText(value);
      if (!name) return null;
      return Object.freeze({
        targetId: keywordId(name),
        kind: TARGET_KIND.KEYWORD,
        name,
        priority: 0
      });
    }

    const source = value && typeof value === 'object' ? value : {};
    const exactId = boundedText(source.teachingClassId || source.classId, 300);
    const kind = exactId || source.kind === TARGET_KIND.TEACHING_CLASS || source.matchMode === 'EXACT_CLASS'
      ? TARGET_KIND.TEACHING_CLASS
      : TARGET_KIND.KEYWORD;
    const name = boundedText(source.name || source.courseName || source.query || source.label);

    if (kind === TARGET_KIND.KEYWORD) {
      if (!name) return null;
      const filters = normalizeTargetFilters(source.filters || {
        teacherFilter: source.teacherFilter,
        timeFilter: source.timeFilter,
        campusFilter: source.campusFilter
      });
      const target = {
        targetId: keywordId(name, filters),
        kind,
        name,
        priority: normalizePriority(source.priority)
      };
      if (Object.keys(filters).length > 0) target.filters = filters;
      return Object.freeze(target);
    }
    if (!exactId) return null;

    const target = {
      targetId: '',
      kind,
      name,
      electiveBatchId: boundedText(source.electiveBatchId || source.batchId, 300),
      teachingClassType: boundedText(source.teachingClassType, 80),
      teachingClassId: exactId,
      queryScope: boundedText(source.queryScope || source.catalogType, 80),
      courseId: boundedText(source.courseId, 300),
      courseNumber: boundedText(source.courseNumber, 200),
      teachingClassNo: boundedText(source.teachingClassNo || source.classNumber, 200),
      teacher: boundedText(source.teacher, 200),
      time: boundedText(source.time, 300),
      campus: boundedText(source.campus, 100),
      priority: normalizePriority(source.priority)
    };
    target.targetId = teachingClassId(target);
    return Object.freeze(Object.fromEntries(Object.entries(target).filter(([, item]) => item !== '')));
  }

  function normalizeTargets(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const target = normalizeTarget(value);
      if (!target || seen.has(target.targetId)) continue;
      seen.add(target.targetId);
      result.push(target);
      if (result.length >= MAX_TARGETS) break;
    }
    return result;
  }

  function mergeTargets(...groups) {
    return normalizeTargets(groups.flatMap(group => Array.isArray(group) ? group : []));
  }

  function singletonGroupId(target) {
    return `group:${identityPart(target.targetId)}`;
  }

  function uniqueGroupId(value, usedIds) {
    const base = boundedText(value, 300) || 'group';
    if (!usedIds.has(base)) return base;
    let suffix = 2;
    while (usedIds.has(`${base}:${suffix}`)) suffix += 1;
    return `${base}:${suffix}`;
  }

  function normalizeRequiredCount(value, targetCount) {
    const requested = Math.trunc(Number(value));
    const requiredCount = Number.isFinite(requested) && requested > 0 ? requested : 1;
    return Math.min(targetCount, requiredCount);
  }

  function normalizeGroups(values) {
    const result = [];
    const seenTargets = new Set();
    const usedGroupIds = new Set();
    for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
      const source = value && typeof value === 'object' ? value : {};
      const targets = normalizeTargets(source.targets || source.courseTargets)
        .filter(target => {
          if (seenTargets.has(target.targetId)) return false;
          seenTargets.add(target.targetId);
          return true;
        });
      if (targets.length === 0) continue;
      const label = boundedText(source.label || source.name, 200)
        || (targets.length === 1 ? targetLabel(targets[0]) : `课程组 ${index + 1}`);
      const proposedId = boundedText(source.groupId || source.id, 300)
        || (targets.length === 1 ? singletonGroupId(targets[0]) : `group:${identityPart(label.toLocaleLowerCase())}`);
      const groupId = uniqueGroupId(proposedId, usedGroupIds);
      usedGroupIds.add(groupId);
      result.push(Object.freeze({
        groupId,
        label,
        requiredCount: normalizeRequiredCount(source.requiredCount, targets.length),
        targets: Object.freeze(targets)
      }));
      if (result.length >= MAX_GROUPS || seenTargets.size >= MAX_TARGETS) break;
    }
    return result;
  }

  function singletonGroupsFromTargets(values) {
    return normalizeTargets(values).map(target => Object.freeze({
      groupId: singletonGroupId(target),
      label: targetLabel(target),
      requiredCount: 1,
      targets: Object.freeze([target])
    }));
  }

  function targetsFromGroups(groups) {
    return normalizeGroups(groups).flatMap(group => group.targets);
  }

  function keywordTargetsFromText(text) {
    return normalizeTargets(String(text || '').split(/\r?\n/));
  }

  function keywordTextFromTargets(targets) {
    return normalizeTargets(targets)
      .filter(target => target.kind === TARGET_KIND.KEYWORD)
      .map(target => target.name)
      .join('\n');
  }

  function normalizeInterval(value) {
    return Math.min(600000, Math.max(1000, Number(value) || 5000));
  }

  function normalizeTaskConfig(value, options = {}) {
    const source = value && typeof value === 'object' ? value : {};
    let groups = normalizeGroups(source.groups || source.configuredGroups);
    if (groups.length === 0) {
      let values = Array.isArray(source.targets)
        ? source.targets
        : Array.isArray(source.configuredTargets)
          ? source.configuredTargets
          : Array.isArray(source.courseNames)
            ? source.courseNames
            : [];
      if (values.length === 0 && options.legacyCourseText) {
        values = String(options.legacyCourseText).split(/\r?\n/);
      }
      groups = singletonGroupsFromTargets(values);
    }
    const targets = groups.flatMap(group => group.targets);
    return {
      schemaVersion: SCHEMA_VERSION,
      intervalMs: normalizeInterval(source.intervalMs ?? options.intervalMs),
      groups,
      // Compatibility view for older callers. groups remains the canonical structure.
      targets,
      updatedAt: Math.max(0, Number(source.updatedAt) || 0)
    };
  }

  function replaceKeywordTargets(configValue, values) {
    const config = normalizeTaskConfig(configValue);
    const requestedKeywords = normalizeTargets(values)
      .filter(target => target.kind === TARGET_KIND.KEYWORD);
    const nameKey = target => target.name.toLocaleLowerCase();
    const requestedNames = new Set(requestedKeywords.map(nameKey));
    const preservedNames = new Set();
    const preservedGroups = config.groups.map(group => {
      const targets = group.targets.filter(target => {
        if (target.kind !== TARGET_KIND.KEYWORD) return true;
        const key = nameKey(target);
        if (!requestedNames.has(key)) return false;
        preservedNames.add(key);
        return true;
      });
      if (targets.length === 0) return null;
      return {
        ...group,
        requiredCount: Math.min(group.requiredCount, targets.length),
        targets
      };
    }).filter(Boolean);
    const keywordGroups = singletonGroupsFromTargets(
      requestedKeywords.filter(target => !preservedNames.has(nameKey(target)))
    );
    return normalizeTaskConfig({
      ...config,
      groups: [...preservedGroups, ...keywordGroups],
      updatedAt: Date.now()
    });
  }

  function addTargetToTaskConfig(configValue, value) {
    const config = normalizeTaskConfig(configValue);
    const target = normalizeTarget(value);
    if (!target || config.targets.some(item => item.targetId === target.targetId)) return config;
    return normalizeTaskConfig({
      ...config,
      groups: [...config.groups, ...singletonGroupsFromTargets([target])],
      updatedAt: Date.now()
    });
  }

  function removeTargetFromTaskConfig(configValue, targetId) {
    const config = normalizeTaskConfig(configValue);
    const groups = config.groups.map(group => {
      const targets = group.targets.filter(target => target.targetId !== targetId);
      if (targets.length === 0) return null;
      return {
        ...group,
        requiredCount: Math.min(group.requiredCount, targets.length),
        targets
      };
    }).filter(Boolean);
    return normalizeTaskConfig({ ...config, groups, updatedAt: Date.now() });
  }

  function updateCourseGroup(configValue, groupId, changes = {}) {
    const config = normalizeTaskConfig(configValue);
    const groups = config.groups.map(group => group.groupId === groupId ? {
      ...group,
      label: Object.hasOwn(changes, 'label') ? boundedText(changes.label, 200) : group.label,
      requiredCount: Object.hasOwn(changes, 'requiredCount') ? changes.requiredCount : group.requiredCount
    } : group);
    return normalizeTaskConfig({ ...config, groups, updatedAt: Date.now() });
  }

  function updateTargetPriority(configValue, targetId, priority) {
    const config = normalizeTaskConfig(configValue);
    const groups = config.groups.map(group => ({
      ...group,
      targets: group.targets.map(target => target.targetId === targetId
        ? { ...target, priority: normalizePriority(priority) }
        : target)
    }));
    return normalizeTaskConfig({ ...config, groups, updatedAt: Date.now() });
  }

  function updateTargetFilters(configValue, targetId, filters) {
    const config = normalizeTaskConfig(configValue);
    const groups = config.groups.map(group => ({
      ...group,
      targets: group.targets.map(target => target.targetId === targetId && target.kind === TARGET_KIND.KEYWORD
        ? { ...target, filters: normalizeTargetFilters(filters) }
        : target)
    }));
    return normalizeTaskConfig({ ...config, groups, updatedAt: Date.now() });
  }

  function moveTargetToGroup(configValue, targetId, destinationGroupId) {
    const config = normalizeTaskConfig(configValue);
    const sourceGroup = config.groups.find(group => group.targets.some(target => target.targetId === targetId));
    const target = config.targets.find(item => item.targetId === targetId);
    if (!sourceGroup || !target || destinationGroupId === sourceGroup.groupId) return config;
    const destinationExists = config.groups.some(group => group.groupId === destinationGroupId);
    const groups = config.groups.map(group => {
      const targets = group.targets.filter(item => item.targetId !== targetId);
      if (destinationExists && group.groupId === destinationGroupId) targets.push(target);
      if (targets.length === 0) return null;
      return {
        ...group,
        requiredCount: Math.min(group.requiredCount, targets.length),
        targets
      };
    }).filter(Boolean);
    if (!destinationExists) groups.push(...singletonGroupsFromTargets([target]));
    return normalizeTaskConfig({ ...config, groups, updatedAt: Date.now() });
  }

  function targetMatchesCourse(targetValue, course = {}) {
    const target = normalizeTarget(targetValue);
    if (!target) return false;
    const text = boundedText(course.text || course.name, 5000);
    const courseNumber = boundedText(course.courseNumber, 200);
    if (target.kind === TARGET_KIND.KEYWORD) return text.includes(target.name);
    if (target.courseNumber && courseNumber) return target.courseNumber === courseNumber;
    return Boolean(target.name && text.includes(target.name));
  }

  function targetAcceptsCandidate(targetValue, candidate = {}) {
    const target = normalizeTarget(targetValue);
    if (!target) return false;
    if (target.kind === TARGET_KIND.KEYWORD) {
      const filters = target.filters || {};
      const contains = (value, query) => !query || boundedText(value, 1000)
        .toLocaleLowerCase()
        .includes(String(query).toLocaleLowerCase());
      return contains(candidate.teacher, filters.teacher)
        && contains(candidate.time, filters.time)
        && contains(candidate.campus, filters.campus);
    }
    if (String(candidate.teachingClassId || '') !== target.teachingClassId) return false;
    if (target.electiveBatchId && candidate.electiveBatchId
      && String(candidate.electiveBatchId) !== target.electiveBatchId) return false;
    // The teaching-class ID is the stable exact identity. Page/API metadata can
    // report a different catalog type after a category switch, so it must not
    // hide the exact class we requested.
    return true;
  }

  const exported = Object.freeze({
    STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_GROUPS,
    MAX_TARGETS,
    TARGET_KIND,
    boundedText,
    normalizeTargetFilters,
    normalizePriority,
    normalizeTarget,
    normalizeTargets,
    normalizeGroups,
    singletonGroupsFromTargets,
    targetsFromGroups,
    mergeTargets,
    keywordTargetsFromText,
    keywordTextFromTargets,
    normalizeTaskConfig,
    replaceKeywordTargets,
    addTargetToTaskConfig,
    removeTargetFromTaskConfig,
    updateCourseGroup,
    updateTargetPriority,
    updateTargetFilters,
    moveTargetToGroup,
    targetLabel,
    targetMatchesCourse,
    targetAcceptsCandidate
  });

  global.NjuGrabTaskModel = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : self);

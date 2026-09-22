export const PCG_GANTT_PHASE_KEYS = Object.freeze({
  stage1: 'asset_prep',
  stage2: 'data_prep',
  stage3: 'feature_prep',
  stage4: 'engine_flow',
  stage5: 'engine_verify',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function isValidDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function normalizeEstimatedDays(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function groupBelongsTo(groupId, ancestorId, groups) {
  let current = groupId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = groups[current]?.parent || null;
  }
  return false;
}

function endpointItems(endpoint, itemIds, dependencies) {
  if (itemIds.has(endpoint)) return [endpoint];
  if (!dependencies.groups?.[endpoint]) return [];
  return [...itemIds].filter((id) => {
    const groupId = dependencies.work_items?.[id]?.group;
    return groupId && groupBelongsTo(groupId, endpoint, dependencies.groups);
  });
}

function phaseKeyForItem(itemId, dependencies) {
  let groupId = dependencies.work_items?.[itemId]?.group || null;
  const visited = new Set();
  while (groupId && !visited.has(groupId)) {
    if (PCG_GANTT_PHASE_KEYS[groupId]) return PCG_GANTT_PHASE_KEYS[groupId];
    visited.add(groupId);
    groupId = dependencies.groups?.[groupId]?.parent || null;
  }
  return null;
}

function errorResult(code, details = {}) {
  return { ok: false, code, ...details, items: {}, phases: {}, total_days: 0 };
}

function durationFor(item) {
  if (item?.status === 'blue') return { days: 0, source: 'skipped' };
  const override = normalizeEstimatedDays(item?.estimated_days);
  if (override !== null) return { days: override, source: 'override' };
  const fallback = normalizeEstimatedDays(item?.default_estimated_days);
  if (fallback !== null) return { days: fallback, source: 'default' };
  return { days: null, source: null };
}

function itemIsIncluded(item) {
  return item?.gantt?.included === true || item?.gantt_included === true;
}

function itemManualStart(item) {
  const value = item?.gantt?.start_date || item?.gantt_start_date;
  return isValidDateKey(value) ? value : null;
}

function itemManualLane(item) {
  const value = item?.gantt?.lane ?? item?.gantt_lane;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function assignLanes(segments) {
  const laneEnds = [];
  return segments
    .slice()
    .sort((a, b) => a.start_offset - b.start_offset || a.id.localeCompare(b.id))
    .map((segment) => {
      const isFree = (lane) => laneEnds[lane] === undefined || laneEnds[lane] <= segment.start_offset;
      let lane = segment.requested_lane;
      // A manual lane is an explicit placement preference. Keep it even when
      // it overlaps another manually placed segment; automatic placement still
      // uses laneEnds to avoid occupied lanes.
      const manualLane = Number.isInteger(lane) && lane >= 0;
      if (!manualLane) {
        lane = laneEnds.findIndex((end) => end === undefined || end <= segment.start_offset);
        if (lane < 0) lane = laneEnds.length;
      }
      laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, segment.finish_offset);
      return { ...segment, lane };
    });
}

export function buildSchedule({ startDate, items, dependencies }) {
  if (!isValidDateKey(startDate)) return errorResult('missing_start_date');
  if (!dependencies?.groups || !dependencies?.work_items || !Array.isArray(dependencies.edges)) {
    return errorResult('missing_dependencies');
  }

  const rows = Array.isArray(items) ? items : [];
  const missingIds = rows.filter((item) => !item?.id || !dependencies.work_items[item.id]);
  if (missingIds.length) {
    return errorResult('missing_work_item_ids', {
      missing_items: missingIds.map((item) => ({ id: item?.id || null, name: item?.name || '' })),
    });
  }

  const itemById = new Map();
  const duplicateIds = new Set();
  for (const item of rows) {
    if (itemById.has(item.id)) duplicateIds.add(item.id);
    itemById.set(item.id, item);
  }
  if (duplicateIds.size) return errorResult('duplicate_work_item_ids', { duplicate_ids: [...duplicateIds].sort() });

  const itemIds = new Set(itemById.keys());
  const mustEdges = [];
  const reverse = new Map([...itemIds].map((id) => [id, new Set()]));
  for (const edge of dependencies.edges) {
    if (edge.type !== 'must_complete') continue;
    const sources = endpointItems(edge.from, itemIds, dependencies);
    const targets = endpointItems(edge.to, itemIds, dependencies);
    for (const source of sources) {
      for (const target of targets) {
        if (source === target || mustEdges.some((entry) => entry.source === source && entry.target === target)) continue;
        mustEdges.push({ source, target });
        reverse.get(target).add(source);
      }
    }
  }

  const includedIds = new Set([...itemIds].filter((id) => itemIsIncluded(itemById.get(id))));
  if (!includedIds.size) return errorResult('no_gantt_items');

  // Hidden must-complete predecessors remain part of the calculation so a visible item cannot bypass dependencies.
  const activeIds = new Set(includedIds);
  const pending = [...includedIds];
  while (pending.length) {
    const id = pending.pop();
    for (const predecessor of reverse.get(id) || []) {
      if (!activeIds.has(predecessor)) {
        activeIds.add(predecessor);
        pending.push(predecessor);
      }
    }
  }

  const missingEstimates = [...activeIds].filter((id) => durationFor(itemById.get(id)).days === null);
  if (missingEstimates.length) {
    return errorResult('missing_estimates', {
      missing_items: missingEstimates.map((id) => ({ id, name: itemById.get(id)?.name || id })),
    });
  }

  const successors = new Map([...activeIds].map((id) => [id, new Set()]));
  const indegree = new Map([...activeIds].map((id) => [id, 0]));
  for (const { source, target } of mustEdges) {
    if (!activeIds.has(source) || !activeIds.has(target)) continue;
    if (successors.get(source).has(target)) continue;
    successors.get(source).add(target);
    indegree.set(target, indegree.get(target) + 1);
  }

  const queue = [...activeIds].filter((id) => indegree.get(id) === 0).sort();
  const startOffsets = new Map([...activeIds].map((id) => {
    const manualStart = itemManualStart(itemById.get(id));
    const offset = manualStart ? Math.max(0, daysBetween(startDate, manualStart)) : 0;
    return [id, offset];
  }));
  const finishOffsets = new Map();
  const ordered = [];

  while (queue.length) {
    const id = queue.shift();
    ordered.push(id);
    const finishOffset = startOffsets.get(id) + durationFor(itemById.get(id)).days;
    finishOffsets.set(id, finishOffset);
    for (const target of successors.get(id)) {
      startOffsets.set(target, Math.max(startOffsets.get(target), finishOffset));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }

  if (ordered.length !== activeIds.size) {
    return errorResult('dependency_cycle', {
      cycle_items: [...activeIds].filter((id) => indegree.get(id) > 0).sort(),
    });
  }

  const scheduledItems = {};
  const phaseOffsets = {};
  let totalDays = 0;
  for (const id of ordered) {
    const item = itemById.get(id);
    const skipped = item.status === 'blue';
    const durationInfo = durationFor(item);
    const duration = durationInfo.days;
    const startOffset = startOffsets.get(id);
    const finishOffset = finishOffsets.get(id);
    const included = includedIds.has(id);
    scheduledItems[id] = {
      start_date: addDays(startDate, startOffset),
      end_date: skipped ? null : addDays(startDate, finishOffset - 1),
      duration_days: duration,
      duration_source: durationInfo.source,
      manual_start_date: itemManualStart(item),
      included,
      skipped,
    };
    totalDays = Math.max(totalDays, finishOffset);

    if (skipped || !included) continue;
    const phaseKey = phaseKeyForItem(id, dependencies);
    if (!phaseKey) continue;
    const current = phaseOffsets[phaseKey] || { start: startOffset, finish: finishOffset, segments: [] };
    current.start = Math.min(current.start, startOffset);
    current.finish = Math.max(current.finish, finishOffset);
    current.segments.push({
      id,
      name: item.name || id,
      status: item.status || 'grey',
      start_offset: startOffset,
      finish_offset: finishOffset,
      duration_days: duration,
      duration_source: durationInfo.source,
      requested_lane: itemManualLane(item),
    });
    phaseOffsets[phaseKey] = current;
  }

  const phases = {};
  for (const [phaseKey, offsets] of Object.entries(phaseOffsets)) {
    phases[phaseKey] = {
      start_date: addDays(startDate, offsets.start),
      end_date: addDays(startDate, offsets.finish - 1),
      duration_days: offsets.finish - offsets.start,
      segments: assignLanes(offsets.segments).map((segment) => ({
        id: segment.id,
        name: segment.name,
        status: segment.status,
        start_date: addDays(startDate, segment.start_offset),
        end_date: addDays(startDate, segment.finish_offset - 1),
        duration_days: segment.duration_days,
        duration_source: segment.duration_source,
        lane: segment.lane,
      })),
    };
  }

  return {
    ok: true,
    code: null,
    start_date: startDate,
    end_date: totalDays > 0 ? addDays(startDate, totalDays - 1) : null,
    total_days: totalDays,
    items: scheduledItems,
    phases,
  };
}

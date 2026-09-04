const EDITABLE_PROFILES = new Set(['modular', 'mixed']);
const MIXED_DEFAULT_USES = ['freeform_area', 'modular_room_placement'];
const ROOM_SIZE_ID_RE = /^(0|[1-9][0-9]*)$/;
const THEME_KEY_RE = /^[A-Za-z0-9]+$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value.trim();
}

function positiveInteger(value, path) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${path} 必须是正整数`);
  }
  return number;
}

function binaryInteger(value, path) {
  const number = Number(value);
  if (number !== 0 && number !== 1) {
    throw new Error(`${path} 必须为 0 或 1`);
  }
  return number;
}

function ensureConfigShape(themeConfig) {
  if (!isPlainObject(themeConfig)) throw new Error('Theme_Configs 必须是对象');
  if (!isPlainObject(themeConfig.Theme_Registry)) themeConfig.Theme_Registry = {};
  if (!isPlainObject(themeConfig.Mode_Configs)) themeConfig.Mode_Configs = {};
  ['modular', 'mixed', 'freeform'].forEach(profile => {
    if (!isPlainObject(themeConfig.Theme_Registry[profile])) themeConfig.Theme_Registry[profile] = {};
    if (!isPlainObject(themeConfig.Mode_Configs[profile])) themeConfig.Mode_Configs[profile] = {};
    if (!isPlainObject(themeConfig.Mode_Configs[profile].themes)) themeConfig.Mode_Configs[profile].themes = {};
  });
}

function roomSizeEntries(value) {
  if (Array.isArray(value)) return value.map(entry => [entry && entry.id, entry]);
  if (isPlainObject(value)) return Object.entries(value);
  throw new Error('Room_Sizes 必须是对象或数组');
}

function roomSizeDimensions(value, path) {
  if (Array.isArray(value) && value.length === 2) return value;
  if (typeof value === 'string') {
    const values = value.trim().split(/\s+/);
    if (values.length === 2) return values;
  }
  if (isPlainObject(value)) return [value.width, value.height];
  throw new Error(`${path} 必须包含 width 和 height`);
}

export function normalizeRoomSizes(value, unitSize) {
  const unit = positiveInteger(unitSize, 'Unit_Size');
  const result = {};
  const ids = new Set();
  roomSizeEntries(value).forEach(([rawId, rawValue]) => {
    const id = String(rawId ?? '').trim();
    const path = `Room_Sizes.${id || '<empty>'}`;
    if (!ROOM_SIZE_ID_RE.test(id)) throw new Error(`${path}.id 必须是非负数字字符串`);
    if (ids.has(id)) throw new Error(`${path}.id 重复`);
    ids.add(id);
    const [rawWidth, rawHeight] = roomSizeDimensions(rawValue, path);
    const width = positiveInteger(rawWidth, `${path}.width`);
    const height = positiveInteger(rawHeight, `${path}.height`);
    if (width % unit !== 0) throw new Error(`${path}.width 必须是 Unit_Size 的倍数`);
    if (height % unit !== 0) throw new Error(`${path}.height 必须是 Unit_Size 的倍数`);
    result[id] = [Math.min(width, height), Math.max(width, height)];
  });
  if (Object.keys(result).length === 0) throw new Error('Room_Sizes 至少包含一个房间尺寸');
  return Object.fromEntries(Object.entries(result).sort((left, right) => Number(left[0]) - Number(right[0])));
}

export function profileFromProgressTheme(subTheme, themeConfig) {
  const key = subTheme && subTheme.abbreviation ? subTheme.abbreviation : '<unknown>';
  const profile = subTheme && subTheme.profile;
  if (EDITABLE_PROFILES.has(profile)) return profile;
  const candidates = [...EDITABLE_PROFILES].filter(value => (
    isPlainObject(themeConfig?.Theme_Registry?.[value]?.[key]) ||
    isPlainObject(themeConfig?.Mode_Configs?.[value]?.themes?.[key])
  ));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error(`主题 ${key} 的 profile 无法唯一推断：${candidates.join('、')}`);
  throw new Error(`主题 ${key} 的 profile 必须是 modular 或 mixed`);
}

export function deriveThemeSpecKey(profile, modeConfig) {
  if (profile === 'modular') {
    return `modular_m${positiveInteger(modeConfig.Tile_Size, 'Tile_Size')}_u${positiveInteger(modeConfig.Unit_Size, 'Unit_Size')}_r${positiveInteger(modeConfig.Road_Width, 'Road_Width')}`;
  }
  if (profile === 'mixed') {
    return `mixed_u${positiveInteger(modeConfig.Unit_Size, 'Unit_Size')}`;
  }
  throw new Error(`不支持推导规格的 profile: ${profile}`);
}

function moduleSpecEntries(moduleTemplates) {
  if (!isPlainObject(moduleTemplates) || !isPlainObject(moduleTemplates.modules)) {
    throw new Error('PCG_Modules_Templates.modules 必须是对象');
  }
  return Object.keys(moduleTemplates.modules);
}

function parseModuleSpec(spec) {
  const modular = /^modular_m([0-9]+)_u([0-9]+)_r([0-9]+)$/.exec(spec);
  if (modular) return { profile: 'modular', tileSize: Number(modular[1]), unitSize: Number(modular[2]), roadWidth: Number(modular[3]) };
  const mixed = /^mixed_u([0-9]+)$/.exec(spec);
  if (mixed) return { profile: 'mixed', unitSize: Number(mixed[1]) };
  return null;
}

function selectModuleSpec(subTheme, profile, existing, moduleTemplates) {
  const candidates = moduleSpecEntries(moduleTemplates).filter(spec => parseModuleSpec(spec)?.profile === profile);
  const hinted = subTheme.moduleSpecId || subTheme.spec_id;
  if (hinted) {
    const parsed = parseModuleSpec(hinted);
    if (!parsed || parsed.profile !== profile || !Object.hasOwn(moduleTemplates.modules, hinted)) {
      throw new Error(`主题 ${subTheme.abbreviation} 的模块规格 ${hinted} 不存在或与模式不匹配`);
    }
    return hinted;
  }
  if (isPlainObject(existing)) {
    const derived = deriveThemeSpecKey(profile, existing);
    if (Object.hasOwn(moduleTemplates.modules, derived)) return derived;
  }
  if (profile === 'mixed' && isPlainObject(subTheme.props) && subTheme.props.Unit_Size !== undefined) {
    const byUnit = candidates.filter(spec => parseModuleSpec(spec).unitSize === Number(subTheme.props.Unit_Size));
    if (byUnit.length === 1) return byUnit[0];
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error(`主题 ${subTheme.abbreviation} 未找到 ${profile} 模块规格`);
  throw new Error(`主题 ${subTheme.abbreviation} 对应多个 ${profile} 模块规格，请在编辑子主题中选择已有规格`);
}

function deriveRoomSizes(moduleTemplates, spec, existingValue) {
  const parsed = parseModuleSpec(spec);
  const sizes = Object.keys(moduleTemplates.modules[spec] || {});
  if (!sizes.length) throw new Error(`规格 ${spec} 至少需要一个房间尺寸`);
  const existing = isPlainObject(existingValue) || Array.isArray(existingValue) ? normalizeRoomSizes(existingValue, parsed.unitSize) : {};
  const byDimensions = new Map(Object.entries(existing).map(([id, value]) => [value.join('x'), id]));
  const usedIds = new Set(Object.keys(existing).map(Number).filter(Number.isInteger));
  let nextId = usedIds.size ? Math.max(...usedIds) + 1 : 0;
  const result = {};
  sizes.forEach(size => {
    const match = /^([0-9]+)x([0-9]+)$/.exec(size);
    if (!match) throw new Error(`规格 ${spec} 的尺寸 ${size} 必须使用 WxH 格式`);
    const dimensions = [positiveInteger(match[1], `${spec}.${size}`), positiveInteger(match[2], `${spec}.${size}`)];
    if (dimensions.some(value => value % parsed.unitSize !== 0)) throw new Error(`规格 ${spec} 的尺寸 ${size} 必须是 Unit_Size 的倍数`);
    const normalized = [Math.min(...dimensions), Math.max(...dimensions)];
    const oldId = byDimensions.get(normalized.join('x'));
    const id = oldId !== undefined ? oldId : String(nextId++);
    result[id] = normalized;
  });
  return Object.fromEntries(Object.entries(result).sort((left, right) => Number(left[0]) - Number(right[0])));
}

function buildRegistryEntry(profile, parent, subTheme, existing) {
  const entry = isPlainObject(existing) ? clone(existing) : {};
  entry.parent = parent;
  entry.display_name = assertNonEmptyString(subTheme.fullName, `主题 ${subTheme.abbreviation}.fullName`);
  entry.sub_theme = subTheme.abbreviation;
  if (profile === 'mixed' && !Array.isArray(entry.uses)) entry.uses = [...MIXED_DEFAULT_USES];
  return entry;
}

function buildModeConfig(profile, props, existing, themeKey, moduleTemplates) {
  if (!moduleTemplates) return existing;
  const spec = selectModuleSpec({ ...(isPlainObject(props) ? props : {}), abbreviation: themeKey }, profile, existing, moduleTemplates);
  const parsed = parseModuleSpec(spec);
  const modeConfig = isPlainObject(existing) ? clone(existing) : {};
  if (profile === 'mixed') {
    modeConfig.Unit_Size = parsed.unitSize;
    modeConfig.Area_Draw_Mode = 'freeform';
    modeConfig.Room_Placement_Mode = 'module';
    modeConfig.Room_Sizes = deriveRoomSizes(moduleTemplates, spec, modeConfig.Room_Sizes);
    ['Tile_Size', 'Road_Width', 'Black_Box', 'Distant_Tile'].forEach(key => { delete modeConfig[key]; });
    return modeConfig;
  }
  modeConfig.Unit_Size = parsed.unitSize;
  modeConfig.Tile_Size = parsed.tileSize;
  modeConfig.Road_Width = parsed.roadWidth;
  ['Black_Box', 'Distant_Tile'].forEach(key => {
    if (modeConfig[key] === undefined) modeConfig[key] = 0;
    modeConfig[key] = binaryInteger(modeConfig[key], `主题 ${themeKey}.${key}`);
  });
  return modeConfig;
}

export function buildThemeConfigPatch(progressTree, baseThemeConfig, moduleTemplates) {
  if (!isPlainObject(progressTree) || !Array.isArray(progressTree.parentThemes)) {
    throw new Error('进度树必须包含 parentThemes 数组');
  }
  const themeConfig = clone(baseThemeConfig);
  ensureConfigShape(themeConfig);
  const seen = new Set();

  progressTree.parentThemes.forEach((parentTheme, parentIndex) => {
    const parent = assertNonEmptyString(parentTheme && parentTheme.fullName, `parentThemes.${parentIndex}.fullName`);
    const subThemes = parentTheme && parentTheme.subThemes;
    if (!Array.isArray(subThemes)) throw new Error(`parentThemes.${parentIndex}.subThemes 必须是数组`);
    subThemes.forEach(subTheme => {
      const profile = profileFromProgressTheme(subTheme, themeConfig);
      const key = assertNonEmptyString(subTheme.abbreviation, `主题 ${profile}.abbreviation`);
      if (!THEME_KEY_RE.test(key)) throw new Error(`主题 ${profile}.${key} 的缩写只能包含英文字母和数字`);
      const identity = `${profile}.${key}`;
      if (seen.has(identity)) throw new Error(`主题 ${identity} 重复`);
      seen.add(identity);

      const registry = themeConfig.Theme_Registry[profile];
      registry[key] = buildRegistryEntry(profile, parent, subTheme, registry[key]);
      const modes = themeConfig.Mode_Configs[profile].themes;
      const modeConfig = buildModeConfig(profile, subTheme, modes[key], key, moduleTemplates);
      if (modeConfig) modes[key] = modeConfig;
    });
  });

  return { themeConfig, diagnostics: [] };
}

export function validateThemeConfigCandidate(themeConfig, moduleTemplates) {
  const errors = [];
  if (!isPlainObject(moduleTemplates) || !isPlainObject(moduleTemplates.modules)) {
    return { ok: false, errors: ['PCG_Modules_Templates.modules 必须是对象'] };
  }
  try {
    ensureConfigShape(themeConfig);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }

  EDITABLE_PROFILES.forEach(profile => {
    const registry = themeConfig.Theme_Registry[profile];
    const modes = themeConfig.Mode_Configs[profile].themes;
    Object.entries(registry).forEach(([key, entry]) => {
      const prefix = `Theme_Registry.${profile}.${key}`;
      try {
        if (!isPlainObject(entry)) throw new Error('必须是对象');
        assertNonEmptyString(entry.parent, `${prefix}.parent`);
        assertNonEmptyString(entry.display_name, `${prefix}.display_name`);
        if (entry.sub_theme !== key) throw new Error(`${prefix}.sub_theme 必须等于 ${key}`);
        if (!isPlainObject(modes[key])) throw new Error(`${prefix}: 缺少 Mode_Configs.${profile}.themes.${key}`);
        const spec = deriveThemeSpecKey(profile, modes[key]);
        if (!Object.hasOwn(moduleTemplates.modules, spec)) throw new Error(`${prefix}: 未找到对应规格 ${spec}`);
      } catch (error) {
        errors.push(error.message);
      }
    });
    Object.keys(modes).forEach(key => {
      if (!Object.hasOwn(registry, key)) errors.push(`Mode_Configs.${profile}.themes.${key}: 未注册 Theme_Registry`);
    });
  });
  return { ok: errors.length === 0, errors };
}

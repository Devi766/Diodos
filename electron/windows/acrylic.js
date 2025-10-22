const os = require('os');

if (process.platform !== 'win32') {
  module.exports = {
    enableAcrylic: () => false
  };
  return;
}

let ref;
let ffi;
let Struct;

try {
  ref = require('ref-napi');
  ffi = require('ffi-napi');
  Struct = require('ref-struct-di')(ref);
} catch (error) {
  console.warn('[Windows Acrylic] 原生依赖未安装，跳过Acrylic效果:', error?.message || error);
  module.exports = {
    enableAcrylic: () => false
  };
  return;
}

const AccentPolicy = Struct({
  AccentState: ref.types.uint32,
  AccentFlags: ref.types.uint32,
  GradientColor: ref.types.uint32,
  AnimationId: ref.types.uint32
});

const WindowCompositionAttribData = Struct({
  Attribute: ref.types.uint32,
  Data: ref.refType(ref.types.void),
  SizeOfData: ref.types.uint32
});

const ACCENT_STATE = {
  ACCENT_DISABLED: 0,
  ACCENT_ENABLE_GRADIENT: 1,
  ACCENT_ENABLE_TRANSPARENTGRADIENT: 2,
  ACCENT_ENABLE_BLURBEHIND: 3,
  ACCENT_ENABLE_ACRYLICBLURBEHIND: 4
};

const WINDOW_COMPOSITION_ATTRIBUTE = {
  WCA_ACCENT_POLICY: 19
};

const user32 = ffi.Library('user32', {
  SetWindowCompositionAttribute: ['int', [ref.refType(ref.types.void), ref.refType(WindowCompositionAttribData)]]
});

function enableAcrylic(win, options = {}) {
  if (process.platform !== 'win32') {
    return false;
  }

  if (!win || typeof win.getNativeWindowHandle !== 'function') {
    return false;
  }

  const hwnd = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(hwnd)) {
    return false;
  }

  const accent = new AccentPolicy();
  accent.AccentState = options.disableBlur
    ? ACCENT_STATE.ACCENT_ENABLE_TRANSPARENTGRADIENT
    : ACCENT_STATE.ACCENT_ENABLE_ACRYLICBLURBEHIND;
  accent.AccentFlags = options.accentFlags ?? 0;

  const tintColor = options.tintColor ?? 0x77000000;
  accent.GradientColor = tintColor >>> 0;
  accent.AnimationId = 0;

  const accentPtr = accent.ref();

  const data = new WindowCompositionAttribData();
  data.Attribute = WINDOW_COMPOSITION_ATTRIBUTE.WCA_ACCENT_POLICY;
  data.Data = accentPtr;
  data.SizeOfData = AccentPolicy.size;

  try {
    const result = user32.SetWindowCompositionAttribute(hwnd, data.ref());
    return result === 1;
  } catch (error) {
    console.warn('SetWindowCompositionAttribute 调用失败:', error?.message || error);
    return false;
  }
}

module.exports = {
  enableAcrylic
};

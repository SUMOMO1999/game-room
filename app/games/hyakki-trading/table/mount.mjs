// Boot installs the native presentation before opening the existing room controller.
let mount = null;
export function registerMerchantTable(factory) { mount = factory; }
export function mountMerchantDesk(options) { return mount?.(options) ?? null; }

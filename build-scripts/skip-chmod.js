/**
 * Skip chmod on Windows during electron-builder packaging
 * This prevents EPERM errors when trying to change permissions on .exe files
 */
exports.default = async function(context) {
  console.log('✓ Skipping chmod on Windows (permissions handled by OS)');
  
  // This function intentionally does nothing
  // It's here to override electron-builder's default chmod behavior
  // which causes EPERM errors on Windows with antivirus software
  
  return Promise.resolve();
};
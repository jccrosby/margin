module.exports.hooks = {
  beforePacking(manifest) {
    return { ...manifest, private: true, os: [process.platform], cpu: [process.arch] };
  }
};

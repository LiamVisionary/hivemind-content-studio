/* electron-builder configuration.
 *
 * It lives here rather than in package.json's `build` field so the bundle id,
 * product name, copyright and Linux maintainer come from the one place they are
 * written down: src/hivemind_content_studio/identity.py, generated into
 * electron/identity.json by `python -m hivemind_content_studio.identity --write`.
 * electron-builder refuses to run with configuration in both places, so
 * package.json no longer carries a `build` block.
 */
const identity = require('./electron/identity.json');
// The version comes from pyproject.toml, not from this package.json, which no
// longer carries one (see scripts/projectVersion.cjs). extraMetadata overrides
// the manifest electron-builder reads, so the packaged app is stamped with the
// product's own version rather than with `undefined`.
const { projectVersion } = require('./scripts/projectVersion.cjs');

module.exports = {
  appId: identity.bundleId,
  extraMetadata: { version: projectVersion() },
  productName: identity.productName,
  copyright: identity.copyright,
  directories: {
    output: 'release',
  },
  afterPack: './afterPack.js',
  files: ['dist/**/*', 'electron/**/*'],
  extraResources: [
    {
      from: 'build/local-ai',
      to: 'local-ai',
      filter: ['**/*'],
    },
  ],
  mac: {
    category: 'public.app-category.graphics-design',
    icon: 'public/banner.png',
    gatekeeperAssess: false,
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
  },
  win: {
    icon: 'public/banner.png',
    signAndEditExecutable: false,
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    include: 'build/installer.nsh',
  },
  linux: {
    icon: 'public/banner.png',
    category: 'Utility',
    maintainer: identity.maintainer,
    extraFiles: [
      { from: 'build/linux/apparmor.profile', to: 'resources/apparmor.profile' },
    ],
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
  },
};

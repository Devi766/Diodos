import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const compatPath = path.join(root, 'public', 'tauri-compat.js');

function loadCompat({ runtimeAvailable = true, handlers = {} } = {}) {
  const source = fs.readFileSync(compatPath, 'utf8');
  const invokeCalls = [];
  const window = {
    electronAPI: undefined,
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost:3000/' },
    navigator: { userAgent: 'FlyClashSmoke' },
    __TAURI__: runtimeAvailable
      ? {
          core: {
            invoke: async (cmd, payload) => {
              invokeCalls.push({ cmd, payload });
              const method = payload?.request?.method;
              if (Object.prototype.hasOwnProperty.call(handlers, method)) {
                const value = handlers[method];
                return typeof value === 'function' ? value(payload) : value;
              }
              return { success: false, error: `unhandled method: ${method}` };
            },
          },
          event: {
            listen: async () => () => {},
          },
        }
      : undefined,
  };

  vm.runInNewContext(source, { window, console });
  return { api: window.electronAPI, invokeCalls, window };
}

async function expectShape(name, value, assertFn) {
  try {
    assertFn(value);
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function main() {
  // 1) No runtime: fallbacks allowed for high-risk methods.
  {
    const { api } = loadCompat({ runtimeAvailable: false });
    assert.equal(await api.isMihomoRunning(), false);
    assert.equal(await api.getProxyStatus(), false);
    assert.equal(await api.getTunStatus(), false);
    const subs = await api.getSubscriptions();
    assert.ok(Array.isArray(subs));
    assert.equal(subs.length, 0);
    assert.equal(await api.getActiveConfig(), null);
    console.log('✓ no-runtime defaults for status methods');
  }

  // 2) Runtime present: backend errors must not be masked by defaults.
  {
    const { api, invokeCalls } = loadCompat({
      runtimeAvailable: true,
      handlers: {
        isMihomoRunning: { success: false, error: 'core down' },
        getProxyStatus: { success: false, error: 'proxy probe failed' },
        getTunStatus: { success: false, error: 'tun probe failed' },
        getSubscriptions: { success: false, error: 'db locked' },
        getActiveConfig: { success: false, error: 'missing active config' },
        getOverrides: { success: false, error: 'override read failed' },
        getLogs: { success: false, error: 'log read failed' },
        getApiConfig: { success: false, error: 'api config failed' },
        fetchConnectionsInfo: { success: false, error: 'connections failed' },
        getAutoStart: { success: false, error: 'autostart failed' },
        getAutoLaunchState: { success: false, error: 'autolaunch failed' },
        checkElevateTask: { success: false, error: 'elevate check failed' },
      },
    });

    await expectShape('runtime error isMihomoRunning', await api.isMihomoRunning(), (v) => {
      assert.equal(v.success, false);
      assert.match(String(v.error || ''), /core down/i);
    });
    await expectShape('runtime error getProxyStatus', await api.getProxyStatus(), (v) => {
      assert.equal(v.success, false);
      assert.match(String(v.error || ''), /proxy probe failed/i);
    });
    await expectShape('runtime error getTunStatus', await api.getTunStatus(), (v) => {
      assert.equal(v.success, false);
      assert.match(String(v.error || ''), /tun probe failed/i);
    });
    await expectShape('runtime error getSubscriptions', await api.getSubscriptions(), (v) => {
      assert.equal(v.success, false);
      assert.match(String(v.error || ''), /db locked/i);
    });
    await expectShape('runtime error getActiveConfig', await api.getActiveConfig(), (v) => {
      assert.equal(v.success, false);
      assert.match(String(v.error || ''), /missing active config/i);
    });
    await expectShape('runtime error getOverrides', await api.getOverrides(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error getLogs', await api.getLogs(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error getApiConfig', await api.getApiConfig(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error fetchConnectionsInfo', await api.fetchConnectionsInfo(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error getAutoStart', await api.getAutoStart(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error getAutoLaunchState', await api.getAutoLaunchState(), (v) => {
      assert.equal(v.success, false);
    });
    await expectShape('runtime error checkElevateTask', await api.checkElevateTask(), (v) => {
      assert.equal(v.success, false);
    });

    assert.ok(invokeCalls.length >= 10, 'expected runtime path to invoke backend');
    console.log('✓ runtime errors are not replaced by defaults');
  }

  // 3) Runtime present: successful status shapes are accepted.
  {
    const { api } = loadCompat({
      runtimeAvailable: true,
      handlers: {
        isMihomoRunning: true,
        getProxyStatus: true,
        getTunStatus: false,
        getSubscriptions: [{ name: 'a', path: '/tmp/a.yaml' }],
        getActiveConfig: '/tmp/a.yaml',
        getOverrides: [],
        getLogs: [{ type: 'info', payload: 'hello', time: 'now' }],
        getApiConfig: { success: true, host: '127.0.0.1', port: 9090 },
        fetchConnectionsInfo: { success: true, connections: [], uploadTotal: 0, downloadTotal: 0 },
        getAutoStart: true,
        getAutoLaunchState: false,
        checkElevateTask: false,
      },
    });

    assert.equal(await api.isMihomoRunning(), true);
    assert.equal(await api.getProxyStatus(), true);
    assert.equal(await api.getTunStatus(), false);
    assert.equal((await api.getSubscriptions()).length, 1);
    assert.equal(await api.getActiveConfig(), '/tmp/a.yaml');
    assert.deepEqual(await api.getOverrides(), []);
    assert.equal((await api.getLogs()).length, 1);
    assert.equal((await api.getApiConfig()).success, true);
    assert.equal((await api.fetchConnectionsInfo()).success, true);
    assert.equal(await api.getAutoStart(), true);
    assert.equal(await api.getAutoLaunchState(), false);
    assert.equal(await api.checkElevateTask(), false);
    console.log('✓ runtime success shapes accepted for high-risk methods');
  }

  console.log('\nAll compat status smoke checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

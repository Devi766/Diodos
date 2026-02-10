/**
 * UWP 回环豁免管理模块
 *
 * 通过 PowerShell 和 CheckNetIsolation 命令行工具来管理 UWP 应用的回环豁免。
 * 替代外部 EnableLoopback.exe 工具，提供应用内管理功能。
 *
 * 技术说明：
 * - UWP 应用运行在 AppContainer 沙箱中，默认无法访问 localhost
 * - 需要管理员权限才能修改回环豁免设置
 * - 使用 CheckNetIsolation 命令管理豁免列表
 * - 使用 PowerShell Get-AppxPackage 枚举已安装的 UWP 应用
 */

const { execSync, exec } = require('child_process');
const path = require('path');

/**
 * 检查当前进程是否以管理员权限运行
 * @returns {boolean}
 */
function isAdmin() {
  try {
    // 尝试执行需要管理员权限的命令
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取当前已豁免回环的 AppContainer SID 列表
 * 使用 CheckNetIsolation 命令获取
 * @returns {Promise<string[]>} 已豁免的 SID 列表
 */
async function getLoopbackExemptList() {
  return new Promise((resolve, reject) => {
    exec(
      'CheckNetIsolation LoopbackExempt -s',
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[LoopbackManager] 获取豁免列表失败:', error.message);
          // 即使命令失败也返回空列表，不阻塞流程
          resolve([]);
          return;
        }

        const sids = [];
        const lines = stdout.split('\n');
        for (const line of lines) {
          // 匹配 SID 格式: S-1-15-2-xxx
          const match = line.match(/(S-1-15-2[\w-]+)/i);
          if (match) {
            sids.push(match[1]);
          }
        }

        console.log(`[LoopbackManager] 当前已豁免 ${sids.length} 个应用`);
        resolve(sids);
      }
    );
  });
}

/**
 * 将 PowerShell 脚本编码为 Base64，用于 -EncodedCommand 参数
 * 这比直接传递脚本字符串更可靠，避免引号和特殊字符转义问题
 * @param {string} script - PowerShell 脚本
 * @returns {string} Base64 编码的脚本
 */
function encodePSCommand(script) {
  // PowerShell -EncodedCommand 需要 UTF-16LE 编码的 Base64
  const buffer = Buffer.from(script, 'utf16le');
  return buffer.toString('base64');
}

/**
 * 枚举所有已安装的 UWP/AppContainer 应用
 * 使用 PowerShell Get-AppxPackage 获取应用列表及其 SID
 * @returns {Promise<Array<{appContainerName: string, displayName: string, packageFamilyName: string, sid: string, workingDir: string}>>}
 */
async function enumAppContainers() {
  return new Promise((resolve, reject) => {
    // PowerShell 脚本：获取所有 AppxPackage 并查询其 AppContainer SID
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$apps = @()
$packages = Get-AppxPackage -AllUsers 2>$null
if (-not $packages) {
  $packages = Get-AppxPackage 2>$null
}
foreach ($pkg in $packages) {
  $sid = $null
  $displayName = $pkg.Name
  $regPath = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings'
  $mappings = Get-ChildItem $regPath 2>$null
  foreach ($mapping in $mappings) {
    $moniker = (Get-ItemProperty $mapping.PSPath -Name 'Moniker' 2>$null).Moniker
    if ($moniker -and $moniker -eq $pkg.PackageFamilyName) {
      $sid = $mapping.PSChildName
      $dn = (Get-ItemProperty $mapping.PSPath -Name 'DisplayName' 2>$null).DisplayName
      if ($dn -and $dn -notlike '@{*') { $displayName = $dn }
      break
    }
  }
  if (-not $sid) {
    $allRegPath = 'HKLM:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings'
    $allMappings = Get-ChildItem $allRegPath 2>$null
    foreach ($mapping in $allMappings) {
      $moniker = (Get-ItemProperty $mapping.PSPath -Name 'Moniker' 2>$null).Moniker
      if ($moniker -and $moniker -eq $pkg.PackageFamilyName) {
        $sid = $mapping.PSChildName
        $dn = (Get-ItemProperty $mapping.PSPath -Name 'DisplayName' 2>$null).DisplayName
        if ($dn -and $dn -notlike '@{*') { $displayName = $dn }
        break
      }
    }
  }
  if ($sid) {
    $apps += [PSCustomObject]@{
      AppContainerName = $pkg.PackageFamilyName
      DisplayName = $displayName
      PackageFamilyName = $pkg.PackageFamilyName
      Sid = $sid
      WorkingDir = $pkg.InstallLocation
    }
  }
}
$apps | ConvertTo-Json -Compress
`;

    const encoded = encodePSCommand(psScript);

    exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 60000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[LoopbackManager] 枚举应用失败:', error.message);
          enumAppContainersFallback().then(resolve).catch(reject);
          return;
        }

        try {
          const trimmed = stdout.trim();
          if (!trimmed || trimmed === '' || trimmed === 'null') {
            console.warn('[LoopbackManager] PowerShell 返回空结果，使用回退方案');
            enumAppContainersFallback().then(resolve).catch(reject);
            return;
          }

          let apps = JSON.parse(trimmed);
          // PowerShell 单个对象不会返回数组
          if (!Array.isArray(apps)) {
            apps = [apps];
          }

          // 标准化字段名
          const result = apps.map(app => ({
            appContainerName: app.AppContainerName || '',
            displayName: app.DisplayName || app.AppContainerName || '',
            packageFamilyName: app.PackageFamilyName || '',
            sid: app.Sid || '',
            workingDir: app.WorkingDir || ''
          })).filter(app => app.sid);

          console.log(`[LoopbackManager] 枚举到 ${result.length} 个 UWP 应用`);
          resolve(result);
        } catch (parseError) {
          console.error('[LoopbackManager] 解析应用列表失败:', parseError.message);
          enumAppContainersFallback().then(resolve).catch(reject);
        }
      }
    );
  });
}

/**
 * 回退方案：直接从注册表读取 AppContainer 映射
 * 当 Get-AppxPackage 不可用时使用
 * @returns {Promise<Array>}
 */
async function enumAppContainersFallback() {
  return new Promise((resolve, reject) => {
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$apps = @()
$regPaths = @(
  'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings',
  'HKLM:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings'
)
$seenSids = @{}
foreach ($regPath in $regPaths) {
  $mappings = Get-ChildItem $regPath 2>$null
  foreach ($mapping in $mappings) {
    $sid = $mapping.PSChildName
    if ($seenSids.ContainsKey($sid)) { continue }
    $seenSids[$sid] = $true
    $moniker = (Get-ItemProperty $mapping.PSPath -Name 'Moniker' 2>$null).Moniker
    $displayName = (Get-ItemProperty $mapping.PSPath -Name 'DisplayName' 2>$null).DisplayName
    if (-not $moniker) { continue }
    if (-not $displayName -or $displayName -like '@{*') { $displayName = $moniker }
    $apps += [PSCustomObject]@{
      AppContainerName = $moniker
      DisplayName = $displayName
      PackageFamilyName = $moniker
      Sid = $sid
      WorkingDir = ''
    }
  }
}
$apps | ConvertTo-Json -Compress
`;

    const encoded = encodePSCommand(psScript);

    exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[LoopbackManager] 回退方案也失败:', error.message);
          resolve([]);
          return;
        }

        try {
          const trimmed = stdout.trim();
          if (!trimmed || trimmed === '' || trimmed === 'null') {
            resolve([]);
            return;
          }

          let apps = JSON.parse(trimmed);
          if (!Array.isArray(apps)) {
            apps = [apps];
          }

          const result = apps.map(app => ({
            appContainerName: app.AppContainerName || '',
            displayName: app.DisplayName || app.AppContainerName || '',
            packageFamilyName: app.PackageFamilyName || '',
            sid: app.Sid || '',
            workingDir: app.WorkingDir || ''
          })).filter(app => app.sid);

          console.log(`[LoopbackManager] 回退方案枚举到 ${result.length} 个应用`);
          resolve(result);
        } catch (parseError) {
          console.error('[LoopbackManager] 回退方案解析失败:', parseError.message);
          resolve([]);
        }
      }
    );
  });
}

/**
 * 添加回环豁免
 * @param {string} sid - AppContainer 的 SID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function addLoopbackExemption(sid) {
  return new Promise((resolve) => {
    exec(
      `CheckNetIsolation LoopbackExempt -a -p=${sid}`,
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[LoopbackManager] 添加豁免失败 (${sid}):`, error.message);
          resolve({ success: false, error: error.message });
          return;
        }
        console.log(`[LoopbackManager] 已添加豁免: ${sid}`);
        resolve({ success: true });
      }
    );
  });
}

/**
 * 移除回环豁免
 * @param {string} sid - AppContainer 的 SID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function removeLoopbackExemption(sid) {
  return new Promise((resolve) => {
    exec(
      `CheckNetIsolation LoopbackExempt -d -p=${sid}`,
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[LoopbackManager] 移除豁免失败 (${sid}):`, error.message);
          resolve({ success: false, error: error.message });
          return;
        }
        console.log(`[LoopbackManager] 已移除豁免: ${sid}`);
        resolve({ success: true });
      }
    );
  });
}

/**
 * 批量设置回环豁免
 * 先清除所有现有豁免，然后添加指定的 SID 列表
 * @param {string[]} sids - 需要豁免的 SID 列表
 * @returns {Promise<{success: boolean, error?: string, added: number, failed: number}>}
 */
async function setLoopbackExemptions(sids) {
  try {
    // 先清除所有现有豁免
    await clearAllLoopbackExemptions();

    let added = 0;
    let failed = 0;

    // 批量添加新的豁免
    for (const sid of sids) {
      const result = await addLoopbackExemption(sid);
      if (result.success) {
        added++;
      } else {
        failed++;
      }
    }

    console.log(`[LoopbackManager] 批量设置完成: 成功 ${added}, 失败 ${failed}`);
    return { success: true, added, failed };
  } catch (error) {
    console.error('[LoopbackManager] 批量设置豁免失败:', error.message);
    return { success: false, error: error.message, added: 0, failed: 0 };
  }
}

/**
 * 清除所有回环豁免
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function clearAllLoopbackExemptions() {
  return new Promise((resolve) => {
    exec(
      'CheckNetIsolation LoopbackExempt -c',
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[LoopbackManager] 清除所有豁免失败:', error.message);
          resolve({ success: false, error: error.message });
          return;
        }
        console.log('[LoopbackManager] 已清除所有豁免');
        resolve({ success: true });
      }
    );
  });
}

/**
 * 获取所有 UWP 应用及其回环豁免状态
 * 这是前端调用的主要接口
 * @returns {Promise<{success: boolean, apps?: Array, isAdmin: boolean, error?: string}>}
 */
async function getAppsWithLoopbackStatus() {
  try {
    const admin = isAdmin();

    // 并行获取应用列表和豁免列表
    const [apps, exemptSids] = await Promise.all([
      enumAppContainers(),
      getLoopbackExemptList()
    ]);

    // 创建 SID 集合用于快速查找
    const exemptSet = new Set(exemptSids.map(s => s.toUpperCase()));

    // 合并状态
    const appsWithStatus = apps.map(app => ({
      ...app,
      isExempt: exemptSet.has(app.sid.toUpperCase())
    }));

    // 按显示名称排序，已豁免的排在前面
    appsWithStatus.sort((a, b) => {
      if (a.isExempt !== b.isExempt) {
        return a.isExempt ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });

    return {
      success: true,
      apps: appsWithStatus,
      isAdmin: admin
    };
  } catch (error) {
    console.error('[LoopbackManager] 获取应用状态失败:', error.message);
    return {
      success: false,
      error: error.message,
      apps: [],
      isAdmin: false
    };
  }
}

/**
 * 保存回环豁免配置
 * 接收前端传来的 SID 列表，批量设置豁免
 * @param {string[]} exemptSids - 需要豁免的 SID 列表
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveLoopbackConfig(exemptSids) {
  try {
    if (!isAdmin()) {
      return {
        success: false,
        error: '需要管理员权限才能修改回环豁免设置'
      };
    }

    const result = await setLoopbackExemptions(exemptSids);
    return result;
  } catch (error) {
    console.error('[LoopbackManager] 保存配置失败:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  isAdmin,
  getLoopbackExemptList,
  enumAppContainers,
  addLoopbackExemption,
  removeLoopbackExemption,
  setLoopbackExemptions,
  clearAllLoopbackExemptions,
  getAppsWithLoopbackStatus,
  saveLoopbackConfig
};

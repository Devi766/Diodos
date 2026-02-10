/**
 * UWP 回环豁免管理模块
 *
 * 通过 PowerShell Add-Type 内联 C# 代码调用 Windows NetworkIsolation API
 * (Firewallapi.dll) 来管理 UWP 应用的回环豁免。
 *
 * 技术说明：
 * - UWP 应用运行在 AppContainer 沙箱中，默认无法访问 localhost
 * - 使用 NetworkIsolationEnumAppContainers 枚举所有 AppContainer
 * - 使用 NetworkIsolationGetAppContainerConfig 获取当前豁免列表
 * - 使用 NetworkIsolationSetAppContainerConfig 设置豁免（不需要管理员权限）
 * - 使用 ConvertSidToStringSid 将 SID 转换为字符串
 * - 不再依赖 CheckNetIsolation 命令行工具，因此不需要管理员权限
 */

const { exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 将 PowerShell 脚本编码为 Base64，用于 -EncodedCommand 参数
 * @param {string} script - PowerShell 脚本
 * @returns {string} Base64 编码的脚本
 */
function encodePSCommand(script) {
  const buffer = Buffer.from(script, 'utf16le');
  return buffer.toString('base64');
}

/**
 * 执行 PowerShell 脚本并返回结果
 * @param {string} script - PowerShell 脚本
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<string>} 标准输出
 */
function execPowerShell(script, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const scriptWithEncoding = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script;
    const encoded = encodePSCommand(scriptWithEncoding);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.message + (stderr ? '\n' + stderr : '')));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * 将长脚本写入临时 .ps1 文件后执行，绕过命令行 8191 字符限制
 *
 * 编码处理说明：
 * - .ps1 文件使用 UTF-8 BOM 编码写入，PowerShell 5.x 通过 BOM 识别 UTF-8
 *   （无 BOM 的 UTF-8 文件会被 PowerShell 5.x 按系统默认编码 GBK 读取，导致中文乱码）
 * - 脚本开头设置 [Console]::OutputEncoding = UTF-8，确保 stdout 输出为 UTF-8
 *   （否则 PowerShell 默认用系统编码输出，Node.js 用 UTF-8 解码会乱码）
 *
 * @param {string} script - PowerShell 脚本
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<string>} 标准输出
 */
function execPowerShellFile(script, timeout = 60000) {
  const tmpFile = path.join(os.tmpdir(), `flycast-ps-${Date.now()}.ps1`);
  // 在脚本开头注入 UTF-8 输出编码设置，确保 stdout 中的中文字符正确传递给 Node.js
  const scriptWithEncoding = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script;
  // 写入 UTF-8 BOM + 脚本内容，PowerShell 5.x 通过 BOM 识别文件编码为 UTF-8
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
  const content = Buffer.concat([BOM, Buffer.from(scriptWithEncoding, 'utf8')]);
  fs.writeFileSync(tmpFile, content);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (error) {
          reject(new Error(error.message + (stderr ? '\n' + stderr : '')));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// C# 源代码文件路径（与本模块同目录）
const CSHARP_SOURCE_PATH = path.join(__dirname, 'loopback-helper.cs');

// 缓存 C# 源代码
let _csharpSourceCache = null;

/**
 * 获取 C# 源代码
 * @returns {string}
 */
function getCSharpSource() {
  if (!_csharpSourceCache) {
    _csharpSourceCache = fs.readFileSync(CSHARP_SOURCE_PATH, 'utf8');
  }
  return _csharpSourceCache;
}

/**
 * 构建 PowerShell 脚本：加载 C# 类型并执行指定方法
 * 使用 PowerShell here-string (@'...'@) 传递 C# 代码，无需转义
 * @param {string} methodCall - 要执行的 C# 方法调用
 * @returns {string} PowerShell 脚本
 */
function buildScript(methodCall) {
  const csharp = getCSharpSource();
  // 使用 PowerShell here-string 语法，C# 代码不需要任何转义
  // 注意：here-string 的 @' 必须在行首，'@ 也必须在行首
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    csharp,
    "'@",
    methodCall
  ].join('\n');
}

/**
 * 验证 SID 格式是否合法
 * Windows AppContainer SID 格式: S-1-15-2- 后跟数字和连字符
 * @param {string} sid
 * @returns {boolean}
 */
function validateSid(sid) {
  return typeof sid === 'string' && /^S-1-15-2(-\d+)+$/i.test(sid);
}

/**
 * 通过 Get-StartApps 和 Get-AppxPackage 获取所有 UWP 包的本地化显示名称
 * 返回一个 Map: packageName/packageFamilyName -> displayName
 * 这是 SHLoadIndirectString 的可靠备选方案
 *
 * 策略：
 * 1. 先用 Get-StartApps 获取所有开始菜单中的应用（已本地化的名称）
 * 2. 再用 Get-AppxPackage 建立 PackageFamilyName -> Name 的映射
 * 3. 通过 AppID 中的 PackageFamilyName 关联两者
 *
 * @returns {Promise<Object>} packageName 到 displayName 的映射
 */
async function getAppxDisplayNames() {
  try {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$results = @{}",
      "",
      "# 方法1: 通过 Get-StartApps 获取本地化名称（最可靠）",
      "try {",
      "  $startApps = Get-StartApps",
      "  foreach ($app in $startApps) {",
      "    if ($app.AppID -and $app.Name -and $app.AppID -like '*!*') {",
      "      # AppID 格式: PackageFamilyName!AppId",
      "      $pfn = ($app.AppID -split '!')[0]",
      "      if ($pfn) {",
      "        $results[$pfn] = $app.Name",
      "      }",
      "    }",
      "  }",
      "} catch {}",
      "",
      "# 方法2: 通过 Get-AppxPackage 补充，用 Name 作为 key",
      "try {",
      "  Get-AppxPackage | ForEach-Object {",
      "    $pkgName = $_.Name",
      "    $pfn = $_.PackageFamilyName",
      "    # 如果 Get-StartApps 已经有了这个 PFN 的名称，也用 Name 作为 key 存一份",
      "    if ($pfn -and $results.ContainsKey($pfn)) {",
      "      $results[$pkgName] = $results[$pfn]",
      "    }",
      "  }",
      "} catch {}",
      "",
      "$results | ConvertTo-Json -Compress -Depth 1"
    ].join('\n');

    const stdout = await execPowerShell(script, 30000);
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null' || trimmed === '{}') {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('[LoopbackManager] 获取 AppxPackage 显示名称失败:', error.message);
    return {};
  }
}

/**
 * 获取所有 UWP 应用及其回环豁免状态
 * 通过 NetworkIsolation API 枚举，不需要管理员权限
 * 然后通过 Get-AppxPackage 补充本地化显示名称
 * @returns {Promise<{success: boolean, apps?: Array, isAdmin: boolean, error?: string}>}
 */
async function getAppsWithLoopbackStatus() {
  try {
    // 并行执行：枚举 AppContainer + 获取 AppxPackage 显示名称
    const [enumResult, displayNames] = await Promise.all([
      (async () => {
        const script = buildScript('[NetworkIsolationHelper]::EnumAppContainers()');
        const stdout = await execPowerShellFile(script);
        return stdout.trim();
      })(),
      getAppxDisplayNames()
    ]);

    if (!enumResult || enumResult === 'null') {
      return { success: true, apps: [], isAdmin: true };
    }

    const parsed = JSON.parse(enumResult);

    // 检查是否返回了错误对象
    if (parsed && !Array.isArray(parsed) && parsed.error) {
      console.error('[LoopbackManager] API 错误:', parsed.error);
      return { success: false, error: parsed.error, apps: [], isAdmin: true };
    }

    const apps = Array.isArray(parsed) ? parsed : [parsed];

    // 合并 Get-AppxPackage 获取的本地化显示名称
    // displayNames 是 { packageName/packageFamilyName -> displayName } 的映射
    // 始终优先使用 Get-StartApps 的结果，因为它返回系统原生本地化名称，比 SHLoadIndirectString 更可靠

    // 构建不区分大小写的查找表：key 全部转小写
    const displayNamesLower = {};
    for (const [key, value] of Object.entries(displayNames)) {
      displayNamesLower[key.toLowerCase()] = value;
    }

    let resolvedCount = 0;
    for (const app of apps) {
      const containerName = (app.appContainerName || '').toLowerCase();
      const pfn = (app.packageFamilyName || '').toLowerCase();

      // 尝试从 getAppxDisplayNames 结果中查找匹配
      let resolved = null;

      // 1. 用 packageFamilyName（真正的 PFN）精确匹配（不区分大小写）
      if (!resolved && pfn && displayNamesLower[pfn]) {
        resolved = displayNamesLower[pfn];
      }

      // 2. 用 appContainerName 精确匹配（不区分大小写）
      if (!resolved && containerName && displayNamesLower[containerName]) {
        resolved = displayNamesLower[containerName];
      }

      // 3. 从 PFN 中提取包名前缀（去掉 _publisherId 后缀）进行匹配
      if (!resolved && pfn) {
        const underscoreIdx = pfn.lastIndexOf('_');
        if (underscoreIdx > 0) {
          const pkgNamePrefix = pfn.substring(0, underscoreIdx);
          if (displayNamesLower[pkgNamePrefix]) {
            resolved = displayNamesLower[pkgNamePrefix];
          }
        }
      }

      // 4. 模糊匹配：遍历 displayNames 的 key，看是否有前缀包含关系
      if (!resolved && containerName) {
        for (const [keyLower, value] of Object.entries(displayNamesLower)) {
          if (keyLower.startsWith(containerName) ||
              containerName.startsWith(keyLower)) {
            resolved = value;
            break;
          }
        }
      }

      if (resolved) {
        app.displayName = resolved;
        resolvedCount++;
      }
    }

    console.log(`[LoopbackManager] 通过 Get-AppxPackage 解析了 ${resolvedCount} 个显示名称`);

    // 按显示名称排序，已豁免的排在前面
    apps.sort((a, b) => {
      if (a.isExempt !== b.isExempt) {
        return a.isExempt ? -1 : 1;
      }
      return (a.displayName || '').localeCompare(b.displayName || '');
    });

    console.log(`[LoopbackManager] 枚举到 ${apps.length} 个 AppContainer`);
    // isAdmin 始终返回 true，因为 NetworkIsolation API 不需要管理员权限
    return { success: true, apps, isAdmin: true };
  } catch (error) {
    console.error('[LoopbackManager] 获取应用状态失败:', error.message);
    return {
      success: false,
      error: error.message,
      apps: [],
      isAdmin: true
    };
  }
}

/**
 * 保存回环豁免配置
 * 通过 NetworkIsolationSetAppContainerConfig API 设置，不需要管理员权限
 * @param {string[]} exemptSids - 需要豁免的 SID 列表
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveLoopbackConfig(exemptSids) {
  try {
    if (!Array.isArray(exemptSids)) {
      return { success: false, error: 'Invalid input: expected array' };
    }

    // 验证所有 SID 格式
    for (const sid of exemptSids) {
      if (!validateSid(sid)) {
        return { success: false, error: `Invalid SID format: ${sid}` };
      }
    }

    // 构建 SID 数组参数
    const sidsParam = exemptSids.length > 0
      ? '$sids = @(' + exemptSids.map(s => `"${s}"`).join(',') + ')\n[NetworkIsolationHelper]::SetConfig($sids)'
      : '$sids = @()\n[NetworkIsolationHelper]::SetConfig($sids)';

    const script = buildScript(sidsParam);
    const stdout = await execPowerShellFile(script, 30000);
    const trimmed = stdout.trim();

    const result = JSON.parse(trimmed);
    if (result.success) {
      console.log(`[LoopbackManager] 保存成功，共豁免 ${result.count} 个应用`);
    } else {
      console.error('[LoopbackManager] 保存失败:', result.error);
    }

    return result;
  } catch (error) {
    console.error('[LoopbackManager] 保存配置失败:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 添加单个回环豁免（保留接口兼容性）
 * @param {string} sid - AppContainer 的 SID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function addLoopbackExemption(sid) {
  if (!validateSid(sid)) {
    return { success: false, error: `Invalid SID format: ${sid}` };
  }
  try {
    const status = await getAppsWithLoopbackStatus();
    if (!status.success) {
      return { success: false, error: status.error };
    }
    const currentExempt = status.apps.filter(a => a.isExempt).map(a => a.sid);
    if (!currentExempt.includes(sid)) {
      currentExempt.push(sid);
    }
    return await saveLoopbackConfig(currentExempt);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 移除单个回环豁免（保留接口兼容性）
 * @param {string} sid - AppContainer 的 SID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function removeLoopbackExemption(sid) {
  if (!validateSid(sid)) {
    return { success: false, error: `Invalid SID format: ${sid}` };
  }
  try {
    const status = await getAppsWithLoopbackStatus();
    if (!status.success) {
      return { success: false, error: status.error };
    }
    const currentExempt = status.apps
      .filter(a => a.isExempt && a.sid.toUpperCase() !== sid.toUpperCase())
      .map(a => a.sid);
    return await saveLoopbackConfig(currentExempt);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  validateSid,
  getAppsWithLoopbackStatus,
  saveLoopbackConfig,
  addLoopbackExemption,
  removeLoopbackExemption
};

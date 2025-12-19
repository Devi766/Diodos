/* eslint-disable */
import fs from 'fs'
import AdmZip from 'adm-zip'
import path from 'path'
import zlib from 'zlib'
import { execSync } from 'child_process'

const cwd = process.cwd()
const TEMP_DIR = path.join(cwd, 'node_modules/.temp')
let arch = process.arch
const platform = process.platform
if (process.argv.slice(2).length !== 0) {
  arch = process.argv.slice(2)[0].replace('--', '')
}

/* ======= mihomo release ======= */
const MIHOMO_VERSION_URL =
  'https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt'
const MIHOMO_URL_PREFIX = `https://github.com/MetaCubeX/mihomo/releases/download`
let MIHOMO_VERSION

const MIHOMO_MAP = {
  'win32-x64': 'mihomo-windows-amd64-compatible',
  'win32-ia32': 'mihomo-windows-386',
  'win32-arm64': 'mihomo-windows-arm64',
  'darwin-x64': 'mihomo-darwin-amd64-compatible',
  'darwin-arm64': 'mihomo-darwin-arm64',
  'linux-x64': 'mihomo-linux-amd64-compatible',
  'linux-arm64': 'mihomo-linux-arm64'
}

// Fetch the latest release version from the version.txt file
async function getLatestReleaseVersion() {
  try {
    const response = await fetch(MIHOMO_VERSION_URL, {
      method: 'GET'
    })
    let v = await response.text()
    MIHOMO_VERSION = v.trim() // Trim to remove extra whitespaces
    console.log(`Latest release version: ${MIHOMO_VERSION}`)
  } catch (error) {
    console.error('Error fetching latest release version:', error.message)
    process.exit(1)
  }
}

/*
 * check available
 */
if (!MIHOMO_MAP[`${platform}-${arch}`]) {
  throw new Error(`unsupported platform "${platform}-${arch}"`)
}

/**
 * core info
 */
function mihomo() {
  const name = MIHOMO_MAP[`${platform}-${arch}`]
  const isWin = platform === 'win32'
  const urlExt = isWin ? 'zip' : 'gz'
  const downloadURL = `${MIHOMO_URL_PREFIX}/${MIHOMO_VERSION}/${name}-${MIHOMO_VERSION}.${urlExt}`
  const exeFile = `${name}${isWin ? '.exe' : ''}`
  const zipFile = `${name}-${MIHOMO_VERSION}.${urlExt}`

  // 保留完整的文件名（包含平台和架构信息），以支持多架构构建
  const targetFile = `${name}-${MIHOMO_VERSION.replace(/^v/, '')}${isWin ? '.exe' : ''}`

  return {
    name: 'mihomo',
    targetFile,
    exeFile,
    zipFile,
    downloadURL
  }
}

/**
 * download sidecar and rename
 */
async function resolveSidecar(binInfo) {
  const { name, targetFile, zipFile, exeFile, downloadURL } = binInfo

  const sidecarDir = path.join(cwd, 'extra', 'sidecar')
  const isWin = platform === 'win32'
  const genericName = `mihomo${isWin ? '.exe' : ''}`
  const sidecarPath = path.join(sidecarDir, genericName)

  fs.mkdirSync(sidecarDir, { recursive: true })

  // 如果文件已存在，跳过下载
  if (fs.existsSync(sidecarPath)) {
    console.log(`[INFO]: "${genericName}" already exists, skipping download`)
    return
  }

  const tempDir = path.join(TEMP_DIR, name)
  const tempZip = path.join(tempDir, zipFile)
  const tempExe = path.join(tempDir, exeFile)

  fs.mkdirSync(tempDir, { recursive: true })
  try {
    if (!fs.existsSync(tempZip)) {
      await downloadFile(downloadURL, tempZip)
    }

    if (zipFile.endsWith('.zip')) {
      const zip = new AdmZip(tempZip)
      zip.getEntries().forEach((entry) => {
        console.log(`[DEBUG]: "${name}" entry name`, entry.entryName)
      })
      zip.extractAllTo(tempDir, true)
      fs.renameSync(tempExe, sidecarPath)
      console.log(`[INFO]: "${name}" unzip finished`)
    } else {
      // gz
      const readStream = fs.createReadStream(tempZip)
      const writeStream = fs.createWriteStream(sidecarPath)
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          console.error(`[ERROR]: "${name}" gz failed:`, error.message)
          reject(error)
        }
        readStream
          .pipe(zlib.createGunzip().on('error', onError))
          .pipe(writeStream)
          .on('finish', () => {
            console.log(`[INFO]: "${name}" gunzip finished`)
            execSync(`chmod 755 ${sidecarPath}`)
            console.log(`[INFO]: "${name}" chmod binary finished`)
            resolve()
          })
          .on('error', onError)
      })
    }

    console.log(`[INFO]: Created "${genericName}" from "${targetFile}"`)
  } catch (err) {
    // 需要删除文件
    if (fs.existsSync(sidecarPath)) {
      fs.rmSync(sidecarPath)
    }
    throw err
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  }
}

/**
 * Windows: 确保 flyclash-helper.exe 始终使用最新源码构建
 * - 如果本机安装了 Go，并且存在 native/helper 目录，则每次 prepare 都会重新编译
 * - 编译结果写入 native/helper/flyclash-helper.exe，并同步到 tools/flyclash-helper.exe
 * - 如果 Go 不存在，则保持现有的预编译版本，不中断打包流程
 */
function resolveHelper() {
  if (platform !== 'win32') {
    return
  }

  // 在 CI（GitHub Actions）中，helper 由 workflow 单独构建到 tools/ 目录，避免与这里的逻辑冲突
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
    console.log('[Helper] CI environment detected, skip local helper build (handled by workflow)')
    return
  }

  const helperDir = path.join(cwd, 'native', 'helper')
  const toolsHelperPath = path.join(cwd, 'tools', 'flyclash-helper.exe')

  if (!fs.existsSync(helperDir)) {
    console.log('[Helper] native/helper directory not found, skip helper build')
    return
  }

  try {
    execSync('go version', { stdio: 'pipe' })
  } catch (e) {
    console.log('[Helper] Go toolchain not found, using existing tools/flyclash-helper.exe')
    return
  }

  try {
    console.log('[Helper] Building flyclash-helper.exe from native/helper ...')
    // 在源码目录生成一个 helper，可根据需要扩展为多架构构建
    execSync('go build -ldflags="-s -w" -o flyclash-helper.exe .', {
      cwd: helperDir,
      stdio: 'inherit'
    })

    // 将最新构建同步到 tools 目录，供 electron-builder extraResources 使用
    const builtHelperPath = path.join(helperDir, 'flyclash-helper.exe')
    fs.mkdirSync(path.dirname(toolsHelperPath), { recursive: true })
    fs.copyFileSync(builtHelperPath, toolsHelperPath)
    console.log('[Helper] Updated tools/flyclash-helper.exe')
  } catch (e) {
    console.error('[Helper] Failed to build helper:', e.message || e)
    // 失败时保留旧版本，不中断整个 prepare
  }
}

/**
 * download the file to the extra dir
 */
async function resolveResource(binInfo) {
  const { file, downloadURL } = binInfo

  const resDir = path.join(cwd, 'tools', 'data')
  const targetPath = path.join(resDir, file)

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath)
  }

  fs.mkdirSync(resDir, { recursive: true })
  await downloadFile(downloadURL, targetPath)

  console.log(`[INFO]: ${file} finished`)
}

/**
 * download file and save to `path`
 */
async function downloadFile(url, path) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/octet-stream' }
  })
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(path, new Uint8Array(buffer))

  console.log(`[INFO]: download finished "${url}"`)
}

const resolveMmdb = () =>
  resolveResource({
    file: 'country.mmdb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country-lite.mmdb`
  })
const resolveGeosite = () =>
  resolveResource({
    file: 'geosite.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat`
  })
const resolveGeoIP = () =>
  resolveResource({
    file: 'geoip.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat`
  })

const tasks = [
  {
    name: 'helper',
    func: resolveHelper,
    retry: 1,
    winOnly: true
  },
  {
    name: 'mihomo',
    func: () => getLatestReleaseVersion().then(() => resolveSidecar(mihomo())),
    retry: 5
  },
  { name: 'mmdb', func: resolveMmdb, retry: 5 },
  { name: 'geosite', func: resolveGeosite, retry: 5 },
  { name: 'geoip', func: resolveGeoIP, retry: 5 }
]

async function runTask() {
  const task = tasks.shift()
  if (!task) return
  if (task.winOnly && platform !== 'win32') return runTask()
  if (task.linuxOnly && platform !== 'linux') return runTask()
  if (task.unixOnly && platform === 'win32') return runTask()
  if (task.darwinOnly && platform !== 'darwin') return runTask()

  for (let i = 0; i < task.retry; i++) {
    try {
      await task.func()
      break
    } catch (err) {
      console.error(`[ERROR]: task::${task.name} try ${i} ==`, err.message)
      if (i === task.retry - 1) {
        if (task.optional) {
          console.log(`[WARN]: Optional task::${task.name} failed, skipping...`)
          break
        } else {
          throw err
        }
      }
    }
  }
  return runTask()
}

runTask()
runTask()


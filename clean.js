const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

console.log('开始清理...');

// 关闭可能正在运行的进程
console.log('尝试关闭正在运行的FlyClash实例...');
exec('taskkill /f /im FlyClash.exe', (error) => {
  if (error) {
    console.log('没有正在运行的FlyClash实例，或无法关闭');
  } else {
    console.log('FlyClash实例已关闭');
  }
  
  // 等待一段时间，确保进程完全关闭
  setTimeout(() => {
    cleanDirectories();
  }, 1000);
});

function removeDirectory(dir, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(dir)) {
        console.log(`删除${path.basename(dir)}目录... (尝试 ${i + 1}/${retries})`);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
        console.log(`${path.basename(dir)}目录已删除`);
        return true;
      } else {
        console.log(`${path.basename(dir)}目录不存在，无需删除`);
        return true;
      }
    } catch (error) {
      if (i === retries - 1) {
        console.error(`删除${path.basename(dir)}目录失败:`, error.message);
        console.log(`提示: 请手动删除 ${dir} 目录，或关闭占用该目录的程序`);
        return false;
      }
      console.log(`删除失败，等待后重试...`);
      // 等待一段时间后重试
      const waitTime = 2000 * (i + 1);
      const start = Date.now();
      while (Date.now() - start < waitTime) {
        // 同步等待
      }
    }
  }
  return false;
}

function cleanDirectories() {
  const releaseDir = path.join(__dirname, 'release');
  const distDir = path.join(__dirname, 'dist');
  const outDir = path.join(__dirname, 'out');

  console.log('开始清理构建目录...');

  let success = true;
  success = removeDirectory(releaseDir) && success;
  success = removeDirectory(distDir) && success;
  success = removeDirectory(outDir) && success;

  if (success) {
    console.log('\n✓ 清理完成！');
    console.log('现在可以运行"npm run electron:build"来重新构建应用程序');
  } else {
    console.log('\n⚠ 清理部分失败，请检查上面的错误信息');
    console.log('建议: 关闭 VSCode 或其他可能占用文件的程序后重试');
  }
}
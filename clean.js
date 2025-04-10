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

function cleanDirectories() {
  const releaseDir = path.join(__dirname, 'release');
  const outDir = path.join(__dirname, 'out');
  
  try {
    // 尝试删除release目录
    if (fs.existsSync(releaseDir)) {
      console.log('删除release目录...');
      fs.rmSync(releaseDir, { recursive: true, force: true });
      console.log('release目录已删除');
    } else {
      console.log('release目录不存在，无需删除');
    }
    
    // 尝试删除out目录
    if (fs.existsSync(outDir)) {
      console.log('删除out目录...');
      fs.rmSync(outDir, { recursive: true, force: true });
      console.log('out目录已删除');
    } else {
      console.log('out目录不存在，无需删除');
    }
    
    console.log('清理完成！');
    console.log('现在可以运行"npm run electron:build"来重新构建应用程序');
  } catch (error) {
    console.error('清理过程中出错:', error);
  }
} 
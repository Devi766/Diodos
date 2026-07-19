const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

/** @type {import('next').NextConfig} */
const createNextConfig = (phase) => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;

  return {
  reactStrictMode: true,
  images: {
    domains: ['localhost'],
    unoptimized: true, // 添加此配置以便静态导出
  },
  // 添加 favicon 配置
  webpack: (config, { isServer, dev }) => {
    // 确保 favicon.ico 只从 public 目录加载
    config.module.rules.push({
      test: /favicon\.ico$/,
      loader: 'file-loader',
      options: {
        name: '[name].[ext]',
        outputPath: 'static/',
      },
    });

    if (dev) {
      // Next.js rewrites config.devtool back to eval-source-map after this
      // function returns. Force a non-eval map via a late plugin so large
      // icon/i18n modules are not stringified into every served chunk.
      config.plugins.push({
        apply(compiler) {
          compiler.options.devtool = 'cheap-module-source-map';
        },
      });
      config.output = {
        ...config.output,
        chunkLoadTimeout: 180000,
      };
    }

    return config;
  },
  ...(isDev ? {} : { output: 'export' }),
  // 允许在开发和生产环境访问过程变量
  env: {
    BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH || '',
  },
  typescript: {
    // Keep the production build honest; run `npx tsc --noEmit` before packaging.
    ignoreBuildErrors: false,
  },
  // 修改资源路径配置
  assetPrefix: '', // 移除相对路径前缀
  basePath: '',
  trailingSlash: !isDev,
  experimental: {
    // Tree-shake barrel packages so layout/dashboard don't pull multi-MB icon sets.
    optimizePackageImports: [
      '@radix-ui/react-icons',
      'lucide-react',
    ],
    // 确保所有页面都被静态生成
    workerThreads: false,
    cpus: 1
  }
  }
}

module.exports = createNextConfig

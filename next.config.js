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
  webpack: (config, { isServer }) => {
    // 确保 favicon.ico 只从 public 目录加载
    config.module.rules.push({
      test: /favicon\.ico$/,
      loader: 'file-loader',
      options: {
        name: '[name].[ext]',
        outputPath: 'static/',
      },
    });
    return config;
  },
  ...(isDev ? {} : { output: 'export' }),
  // 允许在开发和生产环境访问过程变量
  env: {
    BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH || '',
  },
  typescript: {
    // TODO: Fix all TypeScript errors and remove this flag before open-sourcing
    ignoreBuildErrors: true,
  },
  // 修改资源路径配置
  assetPrefix: '', // 移除相对路径前缀
  basePath: '',
  trailingSlash: !isDev,
  experimental: {
    // 确保所有页面都被静态生成
    workerThreads: false,
    cpus: 1
  }
  }
}

module.exports = createNextConfig

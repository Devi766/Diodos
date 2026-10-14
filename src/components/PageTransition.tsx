'use client';

import React from 'react';
import { MotionConfig } from 'motion/react';

interface PageTransitionProps {
  children: React.ReactNode;
  fullHeight?: boolean;
}

// 直接切换内容，不保留退出副本，避免重复挂载页面和整页透明度重绘
export default function PageTransition({ children, fullHeight = false }: PageTransitionProps) {
  return <MotionConfig reducedMotion="user"><div className={fullHeight ? 'h-full min-h-0 w-full' : 'w-full'}>{children}</div></MotionConfig>;
}

'use client';

import React, { useEffect } from 'react';
import Layout from '@/components/Layout';
import BatchSpeedtest from '../../components/BatchSpeedtest';
import { useSpeedTest } from '../../contexts/SpeedTestContext';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function BatchSpeedtestPage() {
  const { isBackgroundTesting, stopBackgroundTest, setShowSpeedTestDialog } = useSpeedTest();
  const router = useRouter();
  
  // 返回工具页面
  const goBack = () => {
    router.push('/tools');
  };
  
  // 在组件加载时重定向到工具页面并打开对话框
  useEffect(() => {
    setShowSpeedTestDialog(true); // 设置对话框为打开状态
    router.push('/tools'); // 重定向到工具页面
  }, [router, setShowSpeedTestDialog]);
  
  return (
    <Layout>
      <div className="container mx-auto py-4 flex justify-center items-center min-h-[300px]">
        <div className="text-center">
          <p className="text-lg">正在跳转到批量测速对话框...</p>
        </div>
      </div>
    </Layout>
  );
} 
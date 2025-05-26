'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

// 测速结果接口 (与BatchSpeedtest组件中保持一致)
interface SpeedTestResult {
  name: string;
  delay: number;
  rttDeviation: number;
  httpDelay: number;
  downloadSpeed: number;
  maxSpeed: number;
  avgSpeed: number;
  udpType: string;
  location?: string;
  type?: string;
}

interface SpeedTestContextType {
  // 测速状态
  isBackgroundTesting: boolean;
  currentNodeName: string;
  testingPhase: string;
  progress: number;
  testResults: SpeedTestResult[];
  skippedNodes: string[];
  proxyGroupName?: string;
  showSpeedTestDialog: boolean;
  
  // 操作方法
  startBackgroundTest: () => void;
  stopBackgroundTest: () => void;
  navigateToTest: () => void;
  setShowSpeedTestDialog: React.Dispatch<React.SetStateAction<boolean>>;
  
  // 结果更新方法 (内部使用)
  setIsBackgroundTesting: React.Dispatch<React.SetStateAction<boolean>>;
  setCurrentNodeName: React.Dispatch<React.SetStateAction<string>>;
  setTestingPhase: React.Dispatch<React.SetStateAction<string>>;
  setProgress: React.Dispatch<React.SetStateAction<number>>;
  setTestResults: React.Dispatch<React.SetStateAction<SpeedTestResult[]>>;
  setSkippedNodes: React.Dispatch<React.SetStateAction<string[]>>;
  setProxyGroupName: React.Dispatch<React.SetStateAction<string | undefined>>;
  
  // 添加新的保存结果相关函数
  registerSaveResultsCallback: (callback: SaveTestResultsFunction, params: any) => void;
  clearSaveResultsCallback: () => void;
}

// 创建上下文
const SpeedTestContext = createContext<SpeedTestContextType | undefined>(undefined);

// 添加保存测试结果的函数类型
export type SaveTestResultsFunction = (results: SpeedTestResult[], params: {
  skippedNodes: string[];
  excludedNodes: string[];
  includedNodes: string[];
  proxyGroupName?: string;
  enableMultiThread?: boolean;
}) => Promise<void>;

// 提供商组件
export function SpeedTestProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  
  // 状态
  const [isBackgroundTesting, setIsBackgroundTesting] = useState(false);
  const [currentNodeName, setCurrentNodeName] = useState('');
  const [testingPhase, setTestingPhase] = useState('');
  const [progress, setProgress] = useState(0);
  const [testResults, setTestResults] = useState<SpeedTestResult[]>([]);
  const [skippedNodes, setSkippedNodes] = useState<string[]>([]);
  const [proxyGroupName, setProxyGroupName] = useState<string | undefined>();
  const [showSpeedTestDialog, setShowSpeedTestDialog] = useState(false);
  
  // 保存测试结果的回调函数
  const [saveResultsCallback, setSaveResultsCallback] = useState<SaveTestResultsFunction | null>(null);
  const [savedParams, setSavedParams] = useState<any>(null);

  // 开始后台测试
  const startBackgroundTest = () => {
    setIsBackgroundTesting(true);
    // 其他初始化操作将在BatchSpeedtest组件中进行
  };
  
  // 停止后台测试
  const stopBackgroundTest = () => {
    setIsBackgroundTesting(false);
    setCurrentNodeName('');
    setTestingPhase('');
    setProgress(0);
    // 保持测试结果不变，便于用户查看
    
    toast.info('批量测速已取消');
  };
  
  // 导航到测试页面 - 修改为打开对话框而不是导航
  const navigateToTest = () => {
    // 不再导航到单独页面，而是打开对话框
    setShowSpeedTestDialog(true);
  };
  
  // 注册保存结果的回调函数
  const registerSaveResultsCallback = (callback: SaveTestResultsFunction, params: any) => {
    setSaveResultsCallback(() => callback);
    setSavedParams(params);
  };
  
  // 清除保存结果的回调函数
  const clearSaveResultsCallback = () => {
    setSaveResultsCallback(null);
    setSavedParams(null);
  };
  
  // 测试结果改变时，如果测试完成且有保存回调，则自动保存
  useEffect(() => {
    const autoSaveResults = async () => {
      // 仅当测试完成(progress=100)、有结果、有保存回调函数时保存
      if (progress === 100 && testResults.length > 0 && saveResultsCallback && savedParams) {
        try {
          console.log('测试已完成，自动保存结果:', testResults.length, '个节点');
          await saveResultsCallback(testResults, savedParams);
          // 保存成功后清除回调，避免重复保存
          clearSaveResultsCallback();
          // 重置测试状态，但保留结果便于查看
          setIsBackgroundTesting(false);
          // 添加500ms延迟，确保保存完成后再重置测试状态
          // 这样原始保存逻辑执行时会检测到已不处于测试状态，跳过保存
          setTimeout(() => {
            setCurrentNodeName('');
            setTestingPhase('');
          }, 500);
        } catch (error) {
          console.error('自动保存测试结果失败:', error);
        }
      }
    };
    
    autoSaveResults();
  }, [progress, testResults, saveResultsCallback, savedParams]);
  
  const contextValue = {
    isBackgroundTesting,
    currentNodeName,
    testingPhase,
    progress,
    testResults,
    skippedNodes,
    proxyGroupName,
    showSpeedTestDialog,
    
    startBackgroundTest,
    stopBackgroundTest,
    navigateToTest,
    setShowSpeedTestDialog,
    
    setIsBackgroundTesting,
    setCurrentNodeName,
    setTestingPhase,
    setProgress,
    setTestResults,
    setSkippedNodes,
    setProxyGroupName,
    
    // 添加新的保存结果相关函数
    registerSaveResultsCallback,
    clearSaveResultsCallback,
  };
  
  return (
    <SpeedTestContext.Provider value={contextValue}>
      {children}
    </SpeedTestContext.Provider>
  );
}

// 自定义Hook，使用上下文
export function useSpeedTest() {
  const context = useContext(SpeedTestContext);
  if (context === undefined) {
    throw new Error('useSpeedTest must be used within a SpeedTestProvider');
  }
  return context;
} 
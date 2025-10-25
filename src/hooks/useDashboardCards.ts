import { useState, useEffect, useCallback } from 'react';
import {
  DashboardCard,
  DEFAULT_DASHBOARD_CARDS,
  DASHBOARD_CONFIG_KEY,
} from '@/types/dashboard';

// 检查是否在 Electron 环境中
const isElectron = typeof window !== 'undefined' && window.electron;

export function useDashboardCards() {
  const [cards, setCards] = useState<DashboardCard[]>(DEFAULT_DASHBOARD_CARDS);
  const [isEditMode, setIsEditMode] = useState(false);

  // 从存储加载配置
  useEffect(() => {
    const loadCards = async () => {
      try {
        if (isElectron) {
          // Electron 环境：使用 IPC 从数据库读取
          const result = await window.electron.ipcRenderer.invoke('get-setting', DASHBOARD_CONFIG_KEY, null);
          if (result.success && result.value) {
            setCards(result.value as DashboardCard[]);
          }
        } else {
          // 浏览器环境：使用 localStorage
          const savedConfig = localStorage.getItem(DASHBOARD_CONFIG_KEY);
          if (savedConfig) {
            const parsedConfig = JSON.parse(savedConfig) as DashboardCard[];
            setCards(parsedConfig);
          }
        }
      } catch (error) {
        console.error('Failed to load dashboard config:', error);
      }
    };

    loadCards();
  }, []);

  // 保存配置到存储
  const saveCards = useCallback(async (newCards: DashboardCard[]) => {
    try {
      if (isElectron) {
        // Electron 环境：使用 IPC 保存到数据库
        const result = await window.electron.ipcRenderer.invoke('set-setting', DASHBOARD_CONFIG_KEY, newCards);
        if (result.success) {
          setCards(newCards);
        } else {
          console.error('Failed to save dashboard config:', result.error);
        }
      } else {
        // 浏览器环境：使用 localStorage
        localStorage.setItem(DASHBOARD_CONFIG_KEY, JSON.stringify(newCards));
        setCards(newCards);
      }
    } catch (error) {
      console.error('Failed to save dashboard config:', error);
    }
  }, []);

  // 更新卡片顺序
  const reorderCards = useCallback(
    async (startIndex: number, endIndex: number) => {
      // 只对已启用的卡片进行排序
      const enabledCardsList = cards
        .filter((card) => card.enabled)
        .sort((a, b) => a.order - b.order);

      const result = Array.from(enabledCardsList);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);

      // 更新order字段
      const reorderedEnabledCards = result.map((card, index) => ({
        ...card,
        order: index,
      }));

      // 合并未启用的卡片
      const disabledCards = cards.filter((card) => !card.enabled);
      const allCards = [...reorderedEnabledCards, ...disabledCards];

      await saveCards(allCards);
    },
    [cards, saveCards],
  );

  // 切换卡片启用状态
  const toggleCard = useCallback(
    async (cardId: string) => {
      const updatedCards = cards.map((card) =>
        card.id === cardId ? { ...card, enabled: !card.enabled } : card,
      );
      await saveCards(updatedCards);
    },
    [cards, saveCards],
  );

  // 添加卡片
  const addCard = useCallback(
    async (card: DashboardCard) => {
      const maxOrder = Math.max(...cards.map((c) => c.order), -1);
      const newCard = { ...card, enabled: true, order: maxOrder + 1 };
      await saveCards([...cards, newCard]);
    },
    [cards, saveCards],
  );

  // 删除卡片
  const removeCard = useCallback(
    async (cardId: string) => {
      const updatedCards = cards
        .filter((card) => card.id !== cardId)
        .map((card, index) => ({ ...card, order: index }));
      await saveCards(updatedCards);
    },
    [cards, saveCards],
  );

  // 重置为默认配置
  const resetToDefault = useCallback(async () => {
    await saveCards(DEFAULT_DASHBOARD_CARDS);
  }, [saveCards]);

  // 获取已启用的卡片(按order排序)
  const enabledCards = cards
    .filter((card) => card.enabled)
    .sort((a, b) => a.order - b.order);

  // 获取可添加的卡片(未启用的)
  const availableCards = DEFAULT_DASHBOARD_CARDS.filter(
    (defaultCard) => !cards.some((card) => card.id === defaultCard.id && card.enabled),
  );

  return {
    cards: enabledCards,
    allCards: cards,
    availableCards,
    isEditMode,
    setIsEditMode,
    reorderCards,
    toggleCard,
    addCard,
    removeCard,
    resetToDefault,
  };
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import {
  DashboardCard,
  DEFAULT_DASHBOARD_CARDS,
  DASHBOARD_CONFIG_KEY,
} from '@/types/dashboard';

const getElectron = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const isTauriRuntimeUnavailable = (result: unknown) =>
  result &&
  typeof result === 'object' &&
  (result as { success?: boolean; error?: string }).success === false &&
  (result as { error?: string }).error === 'Tauri runtime is not available';

let dashboardCardsMemoryCache: DashboardCard[] | null = null;

const normalizeDashboardCards = (value: unknown): DashboardCard[] | null => {
  if (!Array.isArray(value)) return null;
  const knownTypes = new Set(DEFAULT_DASHBOARD_CARDS.map((card) => card.type));
  const knownIds = new Set(DEFAULT_DASHBOARD_CARDS.map((card) => card.id));
  const seenIds = new Set<string>();
  const cards = value.filter((card): card is DashboardCard => {
    if (
      !card ||
      typeof card !== 'object' ||
      typeof (card as DashboardCard).id !== 'string' ||
      !knownTypes.has((card as DashboardCard).type) ||
      typeof (card as DashboardCard).enabled !== 'boolean' ||
      typeof (card as DashboardCard).order !== 'number'
    ) {
      return false;
    }
    // 过滤未知/重复 id，保留用户已删除的状态（不再把默认卡片硬塞回去）
    if (!knownIds.has((card as DashboardCard).id)) return false;
    if (seenIds.has((card as DashboardCard).id)) return false;
    seenIds.add((card as DashboardCard).id);
    return true;
  });
  if (cards.length === 0) return null;

  // 仅补齐「可添加列表」需要的元数据：缺失的默认卡片以 disabled 形式加入，
  // 这样删除后不会自动重新显示在仪表盘上，但仍可在「添加卡片」中找回。
  const missingDefaults = DEFAULT_DASHBOARD_CARDS
    .filter((defaultCard) => !seenIds.has(defaultCard.id))
    .map((defaultCard, index) => ({
      ...defaultCard,
      enabled: false,
      order: cards.length + index,
    }));

  return [...cards, ...missingDefaults];
};

const loadCardsFromLocalStorage = () => {
  try {
    const savedConfig = localStorage.getItem(DASHBOARD_CONFIG_KEY);
    return savedConfig ? normalizeDashboardCards(JSON.parse(savedConfig)) : null;
  } catch {
    return null;
  }
};

const writeCardsToLocalStorage = (cards: DashboardCard[]) => {
  try {
    localStorage.setItem(DASHBOARD_CONFIG_KEY, JSON.stringify(cards));
  } catch {}
};

const readInitialCards = () => {
  if (dashboardCardsMemoryCache) return dashboardCardsMemoryCache;
  if (typeof window === 'undefined') return DEFAULT_DASHBOARD_CARDS;
  const localCards = loadCardsFromLocalStorage();
  if (localCards) {
    dashboardCardsMemoryCache = localCards;
    return localCards;
  }
  return DEFAULT_DASHBOARD_CARDS;
};

export function useDashboardCards() {
  const { t } = useTranslation();
  const [cards, setCards] = useState<DashboardCard[]>(readInitialCards);
  const [isEditMode, setIsEditMode] = useState(false);
  const saveSequenceRef = useRef(0);

  // 从存储加载配置
  useEffect(() => {
    const loadCards = async () => {
      try {
        const electron = getElectron();
        if (electron?.getSetting) {
          // Electron 环境：使用 IPC 从数据库读取
          const result = await electron.getSetting(DASHBOARD_CONFIG_KEY, null);
          if (isTauriRuntimeUnavailable(result)) {
            const localCards = loadCardsFromLocalStorage();
            if (localCards) {
              dashboardCardsMemoryCache = localCards;
              setCards(localCards);
            }
            return;
          }
          if (result?.success === false) {
            throw new Error(result.error || t('dashboard.layoutLoadFailed'));
          }
          if (result?.success) {
            const loadedCards = normalizeDashboardCards(result.value);
            if (loadedCards) {
              dashboardCardsMemoryCache = loadedCards;
              writeCardsToLocalStorage(loadedCards);
              setCards(loadedCards);
            }
          }
        } else {
          // 浏览器环境：使用 localStorage
          const localCards = loadCardsFromLocalStorage();
          if (localCards) {
            dashboardCardsMemoryCache = localCards;
            setCards(localCards);
          }
        }
      } catch (error) {
        console.error('Failed to load dashboard config:', error);
        showToast({
          message: t('dashboard.layoutLoadFailed'),
          type: 'error',
        });
      }
    };

    loadCards();
  }, [t]);

  // 保存配置到存储(仅保存,不更新状态)
  const saveCardsToStorage = useCallback(async (newCards: DashboardCard[]) => {
    try {
      const electron = getElectron();
      if (electron?.setSetting) {
        // Electron 环境：使用 IPC 保存到数据库
        const result = await electron.setSetting(DASHBOARD_CONFIG_KEY, newCards);
        if (isTauriRuntimeUnavailable(result)) {
          dashboardCardsMemoryCache = newCards;
          writeCardsToLocalStorage(newCards);
          return true;
        }
        if (result?.success === false) {
          console.error('Failed to save dashboard config:', result.error);
          return false;
        }
      } else {
        // 浏览器环境：使用 localStorage
        writeCardsToLocalStorage(newCards);
      }
      dashboardCardsMemoryCache = newCards;
      writeCardsToLocalStorage(newCards);
      return true;
    } catch (error) {
      console.error('Failed to save dashboard config:', error);
      return false;
    }
  }, []);

  const applyCardsUpdate = useCallback((updater: (currentCards: DashboardCard[]) => DashboardCard[]) => {
    const saveSequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = saveSequence;

    setCards((currentCards) => {
      const previousCards = currentCards;
      const updatedCards = updater(currentCards);
      dashboardCardsMemoryCache = updatedCards;
      writeCardsToLocalStorage(updatedCards);

      void saveCardsToStorage(updatedCards).then((saved) => {
        if (saved) return;
        if (saveSequenceRef.current !== saveSequence) return;

        dashboardCardsMemoryCache = previousCards;
        writeCardsToLocalStorage(previousCards);
        setCards(previousCards);
        showToast({
          message: t('dashboard.layoutSaveFailed'),
          type: 'error',
        });
      });

      return updatedCards;
    });
  }, [saveCardsToStorage, t]);

  // 更新卡片顺序
  const reorderCards = useCallback(
    async (startIndex: number, endIndex: number) => {
      applyCardsUpdate((currentCards) => {
        // 只对已启用的卡片进行排序
        const enabledCardsList = currentCards
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
        const disabledCards = currentCards.filter((card) => !card.enabled);
        return [...reorderedEnabledCards, ...disabledCards];
      });
    },
    [applyCardsUpdate],
  );

  // 切换卡片启用状态
  const toggleCard = useCallback(
    async (cardId: string) => {
      applyCardsUpdate((currentCards) =>
        currentCards.map((card) =>
          card.id === cardId ? { ...card, enabled: !card.enabled } : card,
        ),
      );
    },
    [applyCardsUpdate],
  );

  // 添加卡片
  const addCard = useCallback(
    async (card: DashboardCard) => {
      applyCardsUpdate((currentCards) => {
        const existing = currentCards.find((c) => c.id === card.id);
        if (existing) {
          // 已存在但被禁用/删除过：重新启用并放到末尾
          const maxOrder = Math.max(
            ...currentCards.filter((c) => c.enabled).map((c) => c.order),
            -1,
          );
          return currentCards.map((c) =>
            c.id === card.id ? { ...c, enabled: true, order: maxOrder + 1 } : c,
          );
        }
        const maxOrder = Math.max(...currentCards.map((c) => c.order), -1);
        const newCard = { ...card, enabled: true, order: maxOrder + 1 };
        return [...currentCards, newCard];
      });
    },
    [applyCardsUpdate],
  );

  // 删除卡片（标记为禁用，保留配置以便「添加」时可找回，且不会在加载时被默认配置覆盖）
  const removeCard = useCallback(
    async (cardId: string) => {
      applyCardsUpdate((currentCards) =>
        currentCards.map((card) =>
          card.id === cardId ? { ...card, enabled: false } : card,
        ),
      );
    },
    [applyCardsUpdate],
  );

  // 重置为默认配置
  const resetToDefault = useCallback(async () => {
    applyCardsUpdate(() => DEFAULT_DASHBOARD_CARDS);
  }, [applyCardsUpdate]);

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

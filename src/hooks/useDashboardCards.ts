import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import { removeDashboardImage } from '@/lib/dashboard-images';
import {
  DashboardCard,
  DashboardCardType,
  DEFAULT_DASHBOARD_CARDS,
  DASHBOARD_CONFIG_KEY,
  LEGACY_CARD_IDS,
  cardBaseId,
  getCardDefinition,
  isCardCopyId,
  isDashboardCardType,
  isValidCardId,
  newCardCopyId,
  resolveCardVariant,
  migrateLegacyControlCards,
  migrateLegacyMetricCards,
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

// 把一条已保存的卡片记录规整为当前格式；无法识别时返回 null
const normalizeCardEntry = (value: unknown): DashboardCard | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !isDashboardCardType(raw.type)) return null;
  if (typeof raw.enabled !== 'boolean' || typeof raw.order !== 'number') return null;

  const type = raw.type;
  const id = LEGACY_CARD_IDS[raw.id] === type ? type : raw.id;
  if (!isValidCardId(id, type)) return null;

  const card: DashboardCard = { id, type, enabled: raw.enabled, order: raw.order };
  const variant = resolveCardVariant(type, typeof raw.variant === 'string' ? raw.variant : undefined);
  if (variant.id !== getCardDefinition(type).variants[0].id) {
    card.variant = variant.id;
  }
  return card;
};

const normalizeDashboardCards = (value: unknown): DashboardCard[] | null => {
  if (!Array.isArray(value)) return null;
  const seenIds = new Set<string>();
  const cards: DashboardCard[] = [];
  for (const entry of migrateLegacyMetricCards(migrateLegacyControlCards(value))) {
    const card = normalizeCardEntry(entry);
    if (!card || seenIds.has(card.id)) continue;
    // 副本只在启用时保留，删除副本即从配置中移除
    if (isCardCopyId(card.id) && !card.enabled) continue;
    seenIds.add(card.id);
    cards.push(card);
  }
  if (cards.length === 0) return null;

  // 缺失的卡片本体以 disabled 形式补齐，删除过的卡片不会自动回到仪表盘
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

  // 添加卡片：本体未在仪表盘上时启用本体，否则新建一张副本；新卡片放到末尾
  const addCard = useCallback(
    async (type: DashboardCardType, variantId?: string) => {
      // 副本 id 在更新函数外生成，保证更新函数重复执行时结果一致
      const copyId = newCardCopyId(type);
      applyCardsUpdate((currentCards) => {
        const variant = resolveCardVariant(type, variantId);
        const isDefaultVariant = variant.id === getCardDefinition(type).variants[0].id;
        const maxOrder = Math.max(
          ...currentCards.filter((c) => c.enabled).map((c) => c.order),
          -1,
        );
        const withVariant = (card: DashboardCard): DashboardCard => {
          const { variant: _previous, ...rest } = card;
          return isDefaultVariant ? rest : { ...rest, variant: variant.id };
        };

        const base = currentCards.find((c) => c.id === type);
        if (base && !base.enabled) {
          return currentCards.map((c) =>
            c.id === type ? withVariant({ ...c, enabled: true, order: maxOrder + 1 }) : c,
          );
        }

        const id = base ? copyId : type;
        return [...currentCards, withVariant({ id, type, enabled: true, order: maxOrder + 1 })];
      });
    },
    [applyCardsUpdate],
  );

  // 删除卡片：副本直接移除；本体标记为禁用，加载时不会被默认配置重新塞回仪表盘
  const removeCard = useCallback(
    async (cardId: string) => {
      if (cardBaseId(cardId) === 'image') {
        void removeDashboardImage(cardId).catch(() => {});
      }
      applyCardsUpdate((currentCards) =>
        isCardCopyId(cardId)
          ? currentCards.filter((card) => card.id !== cardId)
          : currentCards.map((card) =>
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

  return {
    cards: enabledCards,
    allCards: cards,
    isEditMode,
    setIsEditMode,
    reorderCards,
    toggleCard,
    addCard,
    removeCard,
    resetToDefault,
  };
}

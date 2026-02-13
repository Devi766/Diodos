'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAiStore } from '@/stores/ai-store';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MessageSquarePlus, Trash2 } from 'lucide-react';

interface ConversationListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ConversationList({ open, onOpenChange }: ConversationListProps) {
  const { t } = useTranslation();
  const store = useAiStore();

  const handleSelect = (id: string) => {
    store.setCurrentConversation(id);
    onOpenChange(false);
  };

  const handleNew = () => {
    store.createConversation();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[480px] !p-5 !rounded-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('ai.conversations')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2 min-h-0 flex-1">
          <Button variant="outline" size="sm" onClick={handleNew} className="w-full gap-1.5 shrink-0">
            <MessageSquarePlus className="w-4 h-4" />
            {t('ai.newConversation')}
          </Button>

          {store.conversations.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {t('ai.noConversations')}
            </div>
          ) : (
            <div className="space-y-1 overflow-y-auto custom-scrollbar min-h-0 max-h-[50vh]">
              {store.conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => handleSelect(conv.id)}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2.5 cursor-pointer transition-colors ${
                    conv.id === store.currentConversationId
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-muted/60 border border-transparent'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {conv.title || t('ai.untitledConversation')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {conv.messages.length} {t('ai.messages')} · {new Date(conv.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      store.deleteConversation(conv.id);
                    }}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import { ReloadIcon, PlusIcon, TrashIcon, Pencil1Icon, FileTextIcon, DotsVerticalIcon, DragHandleDots2Icon } from '@radix-ui/react-icons';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type OverrideItem = {
  id: string;
  name: string;
  type: 'local' | 'remote';
  ext: 'js' | 'yaml';
  url?: string;
  file?: string;
  enabled: boolean;
  global?: boolean;
  updatedAt?: string;
};

// 可排序的卡片组件
function SortableOverrideCard({
  item,
  onToggle,
  onUpdate,
  onDelete,
  onEdit,
  onEditFile
}: {
  item: OverrideItem;
  onToggle: (id: string, enabled: boolean) => void;
  onUpdate: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (item: OverrideItem) => void;
  onEditFile: (item: OverrideItem) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return '未知';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return `${days}天前`;
  };

  const [showMenu, setShowMenu] = useState(false);

  return (
    <div ref={setNodeRef} style={style}>
      <Card className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1">
            {/* 拖拽手柄 */}
            <div
              {...attributes}
              {...listeners}
              className="cursor-grab active:cursor-grabbing mt-1 text-muted-foreground hover:text-foreground"
            >
              <DragHandleDots2Icon className="w-5 h-5" />
            </div>

            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="font-medium text-foreground">{item.name}</h4>
                {item.global && (
                  <span className="px-2 py-0.5 text-xs rounded font-medium bg-primary/10 text-primary">
                    全局
                  </span>
                )}
                <span className={`px-2 py-0.5 text-xs rounded font-medium ${
                  item.ext === 'js'
                    ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'
                    : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                }`}>
                  {item.ext.toUpperCase()}
                </span>
                <span className={`px-2 py-0.5 text-xs rounded font-medium ${
                  item.type === 'remote'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}>
                  {item.type === 'remote' ? '远程' : '本地'}
                </span>
              </div>
              {item.url && (
                <p className="text-sm text-muted-foreground mb-1 break-all">{item.url}</p>
              )}
              <p className="text-xs text-muted-foreground">{formatDate(item.updatedAt)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <Switch
              checked={item.enabled}
              onCheckedChange={(checked) => onToggle(item.id, checked)}
            />
            {item.type === 'remote' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onUpdate(item.id)}
                title="更新"
              >
                <ReloadIcon className="w-4 h-4" />
              </Button>
            )}

            {/* 更多菜单 */}
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowMenu(!showMenu)}
              >
                <DotsVerticalIcon className="w-4 h-4" />
              </Button>

              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-[#2a2a2a] rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 z-20">
                    <button
                      onClick={() => {
                        onEdit(item);
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                    >
                      <Pencil1Icon className="w-4 h-4" />
                      编辑信息
                    </button>
                    <button
                      onClick={() => {
                        onEditFile(item);
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                    >
                      <FileTextIcon className="w-4 h-4" />
                      编辑文件
                    </button>
                    <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                    <button
                      onClick={() => {
                        onDelete(item.id);
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center gap-2"
                    >
                      <TrashIcon className="w-4 h-4" />
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function Overrides() {
  const [items, setItems] = useState<OverrideItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<OverrideItem | null>(null);
  const [editingFile, setEditingFile] = useState<OverrideItem | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);

        const newItems = [...items];
        const [removed] = newItems.splice(oldIndex, 1);
        newItems.splice(newIndex, 0, removed);

        // 保存新顺序
        if (typeof window !== 'undefined' && window.electronAPI?.reorderOverrides) {
          window.electronAPI.reorderOverrides(newItems.map(item => item.id)).catch(error => {
            console.error('保存排序失败:', error);
          });
        }

        return newItems;
      });
    }
  };

  const fetchItems = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.getOverrides) {
        const items = await window.electronAPI.getOverrides();
        setItems(items || []);
      } else {
        setItems([]);
      }
    } catch (error: any) {
      console.error('获取覆写列表失败:', error);
      setErrorMessage(`获取覆写列表失败: ${error.message || '未知错误'}`);
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (!url) return;

    setImporting(true);
    try {
      const urlObj = new URL(url);
      const name = urlObj.pathname.split('/').pop();

      if (typeof window !== 'undefined' && window.electronAPI?.addOverride) {
        await window.electronAPI.addOverride({
          name: name ? decodeURIComponent(name) : 'Untitled',
          type: 'remote',
          url,
          ext: urlObj.pathname.endsWith('.js') ? 'js' : 'yaml'
        });
        await fetchItems();
      }

      setUrl('');
    } catch (error: any) {
      console.error('导入覆写失败:', error);
      alert(`导入失败: ${error.message || '未知错误'}`);
    } finally {
      setImporting(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.updateOverride) {
        await window.electronAPI.updateOverride(id, { enabled });
        setItems(prev => prev.map(item =>
          item.id === id ? { ...item, enabled } : item
        ));
      }
    } catch (error: any) {
      console.error('切换覆写状态失败:', error);
      alert(`操作失败: ${error.message || '未知错误'}`);
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.updateRemoteOverride) {
        await window.electronAPI.updateRemoteOverride(id);
        await fetchItems();
      }
    } catch (error: any) {
      console.error('更新覆写失败:', error);
      alert(`更新失败: ${error.message || '未知错误'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个覆写吗？')) return;

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.deleteOverride) {
        await window.electronAPI.deleteOverride(id);
        setItems(prev => prev.filter(item => item.id !== id));
      }
    } catch (error: any) {
      console.error('删除覆写失败:', error);
      alert(`删除失败: ${error.message || '未知错误'}`);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
    } catch (error) {
      console.error('粘贴失败:', error);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileOver(false);

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    if (!file.name.endsWith('.js') && !file.name.endsWith('.yaml')) {
      alert('仅支持 .js 和 .yaml 文件');
      return;
    }

    try {
      const content = await file.text();

      if (typeof window !== 'undefined' && window.electronAPI?.addOverride) {
        await window.electronAPI.addOverride({
          name: file.name,
          type: 'local',
          file: content,
          ext: file.name.endsWith('.js') ? 'js' : 'yaml'
        });
        await fetchItems();
      }
    } catch (error: any) {
      console.error('添加文件失败:', error);
      alert(`添加失败: ${error.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <ReloadIcon className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div 
      className="space-y-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽提示 */}
      {fileOver && (
        <div className="fixed inset-0 z-50 bg-primary/10 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-white dark:bg-[#2a2a2a] rounded-xl p-8 shadow-2xl border-2 border-primary border-dashed">
            <FileTextIcon className="w-16 h-16 mx-auto mb-4 text-primary" />
            <p className="text-lg font-medium text-foreground">拖放文件到此处</p>
            <p className="text-sm text-muted-foreground mt-2">支持 .js 和 .yaml 文件</p>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {errorMessage}
        </div>
      )}

      {/* 导入工具栏 */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="输入远程URL导入覆写..."
            className="w-full h-9 px-3 pr-10 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            onClick={handlePaste}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title="粘贴"
          >
            <FileTextIcon className="w-4 h-4" />
          </button>
        </div>
        <Button
          size="sm"
          onClick={handleImport}
          disabled={!url || importing}
        >
          {importing ? <ReloadIcon className="w-4 h-4 animate-spin" /> : '导入'}
        </Button>

        {/* 添加按钮下拉菜单 */}
        <div className="relative">
          <Button
            size="sm"
            variant="solid"
            onClick={() => setShowAddMenu(!showAddMenu)}
          >
            <PlusIcon className="w-4 h-4 mr-1" />
            添加
          </Button>

          {showAddMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowAddMenu(false)}
              />
              <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#2a2a2a] rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 z-20">
                <button
                  onClick={async () => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.js,.yaml';
                    input.onchange = async (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) {
                        try {
                          const content = await file.text();
                          if (typeof window !== 'undefined' && window.electronAPI?.addOverride) {
                            await window.electronAPI.addOverride({
                              name: file.name,
                              type: 'local',
                              file: content,
                              ext: file.name.endsWith('.js') ? 'js' : 'yaml'
                            });
                            await fetchItems();
                          }
                        } catch (error: any) {
                          console.error('添加文件失败:', error);
                          alert(`添加失败: ${error.message || '未知错误'}`);
                        }
                      }
                    };
                    input.click();
                    setShowAddMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                >
                  <FileTextIcon className="w-4 h-4" />
                  打开本地文件
                </button>
                <button
                  onClick={async () => {
                    try {
                      if (typeof window !== 'undefined' && window.electronAPI?.addOverride) {
                        await window.electronAPI.addOverride({
                          name: '新建配置.yaml',
                          type: 'local',
                          file: '# YAML 配置文件\n',
                          ext: 'yaml'
                        });
                        await fetchItems();
                      }
                    } catch (error: any) {
                      console.error('创建文件失败:', error);
                      alert(`创建失败: ${error.message || '未知错误'}`);
                    }
                    setShowAddMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                >
                  <FileTextIcon className="w-4 h-4" />
                  新建 YAML 配置
                </button>
                <button
                  onClick={async () => {
                    try {
                      if (typeof window !== 'undefined' && window.electronAPI?.addOverride) {
                        await window.electronAPI.addOverride({
                          name: '新建脚本.js',
                          type: 'local',
                          file: '// JavaScript 脚本\nfunction main(config) {\n  return config;\n}\n',
                          ext: 'js'
                        });
                        await fetchItems();
                      }
                    } catch (error: any) {
                      console.error('创建文件失败:', error);
                      alert(`创建失败: ${error.message || '未知错误'}`);
                    }
                    setShowAddMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                >
                  <FileTextIcon className="w-4 h-4" />
                  新建 JS 脚本
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 覆写列表 */}
      {items.length === 0 ? (
        <Card className="p-12 text-center">
          <FileTextIcon className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground mb-2">暂无覆写配置</p>
          <p className="text-sm text-muted-foreground">拖放文件或输入URL导入覆写</p>
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {items.map((item) => (
                <SortableOverrideCard
                  key={item.id}
                  item={item}
                  onToggle={handleToggle}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                  onEdit={setEditingItem}
                  onEditFile={setEditingFile}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* 编辑信息对话框 */}
      {editingItem && (
        <EditInfoDialog
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={async (updatedItem) => {
            try {
              if (typeof window !== 'undefined' && window.electronAPI?.updateOverride) {
                await window.electronAPI.updateOverride(updatedItem.id, {
                  name: updatedItem.name,
                  url: updatedItem.url,
                  global: updatedItem.global
                });
                setItems(prev => prev.map(item =>
                  item.id === updatedItem.id ? updatedItem : item
                ));
                setEditingItem(null);
              }
            } catch (error: any) {
              console.error('更新覆写信息失败:', error);
              alert(`更新失败: ${error.message || '未知错误'}`);
            }
          }}
        />
      )}

      {/* 编辑文件对话框 */}
      {editingFile && (
        <EditFileDialog
          item={editingFile}
          onClose={() => setEditingFile(null)}
          onSave={async (content) => {
            try {
              if (typeof window !== 'undefined' && window.electronAPI?.updateOverrideFileContent) {
                await window.electronAPI.updateOverrideFileContent(editingFile.id, content);
                setEditingFile(null);
                await fetchItems();
              }
            } catch (error: any) {
              console.error('更新覆写文件失败:', error);
              alert(`更新失败: ${error.message || '未知错误'}`);
            }
          }}
        />
      )}
    </div>
  );
}

// 编辑信息对话框
function EditInfoDialog({
  item,
  onClose,
  onSave,
}: {
  item: OverrideItem;
  onClose: () => void;
  onSave: (item: OverrideItem) => void;
}) {
  const [name, setName] = useState(item.name);
  const [url, setUrl] = useState(item.url || '');
  const [global, setGlobal] = useState(item.global || false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="p-6 border-b border-slate-200 dark:border-slate-700">
          <h3 className="text-lg font-semibold text-foreground">编辑信息</h3>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          {item.type === 'remote' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                URL
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              全局覆写
            </label>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => setGlobal(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 dark:bg-slate-700 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-slate-600 peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
        <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onSave({
                ...item,
                name,
                url: item.type === 'remote' ? url : item.url,
                global,
              });
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

// 编辑文件对话框
function EditFileDialog({
  item,
  onClose,
  onSave,
}: {
  item: OverrideItem;
  onClose: () => void;
  onSave: (content: string) => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI?.getOverrideFileContent) {
          const fileContent = await window.electronAPI.getOverrideFileContent(item.id);
          setContent(fileContent);
        } else {
          setContent(item.file || '');
        }
      } catch (error: any) {
        console.error('加载文件内容失败:', error);
        alert(`加载失败: ${error.message || '未知错误'}`);
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [item.id, item.file]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col">
        <div className="p-6 border-b border-slate-200 dark:border-slate-700">
          <h3 className="text-lg font-semibold text-foreground">
            编辑文件 - {item.name}
          </h3>
        </div>
        <div className="flex-1 p-6 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <ReloadIcon className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
              placeholder={item.ext === 'js' ? '// JavaScript 代码' : '# YAML 配置'}
            />
          )}
        </div>
        <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onSave(content)} disabled={loading}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}


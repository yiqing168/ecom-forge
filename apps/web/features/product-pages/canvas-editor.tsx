'use client';

import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import {
  AlertTriangle,
  ArrowLeft,
  CirclePlay,
  Download,
  FileText,
  History,
  ImageIcon,
  ListTodo,
  MousePointer2,
  Move,
  Redo2,
  Undo2,
  Upload,
  Video,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CanvasActionsContext } from '@/features/product-pages/canvas-model';
import { nodeTypes } from '@/features/product-pages/canvas-node';
import { useCanvasEditorState } from '@/features/product-pages/use-canvas-editor-state';

function CanvasEditorInner() {
  const {
    addNode,
    authorized,
    canvasActions,
    drawer,
    edges,
    executeRun,
    isMobile,
    loadRemoteSnapshot,
    nodeColor,
    nodes,
    onConnect,
    onEdgesChange,
    onNodesChange,
    remoteSnapshot,
    router,
    runMessage,
    runRequest,
    saveAsCopy,
    saved,
    setDrawer,
    setRemoteSnapshot,
    setRunRequest,
    simulateConflict,
  } = useCanvasEditorState();

  if (!authorized) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--background)]">
        <p className="text-sm text-[var(--muted-foreground)]">正在验证登录状态…</p>
      </main>
    );
  }

  return (
    <CanvasActionsContext.Provider value={canvasActions}>
      <div className="h-dvh overflow-hidden bg-[var(--canvas-background)]">
        <header className="relative z-20 flex h-14 items-center gap-2 border-b border-[var(--border)] bg-white px-3 sm:px-4">
          <button
            aria-label="返回画布列表"
            className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
            onClick={() => router.push('/canvases')}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={18} />
          </button>
          <div className="ml-1 min-w-0">
            <p className="truncate text-sm font-bold">夏季时装 campaign</p>
            <p className="text-xs text-[var(--muted-foreground)]">{saved ? '已保存' : '保存中…'}</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              aria-label="撤销"
              className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
              type="button"
            >
              <Undo2 aria-hidden="true" size={17} />
            </button>
            <button
              aria-label="重做"
              className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
              type="button"
            >
              <Redo2 aria-hidden="true" size={17} />
            </button>
            <button
              className="hidden min-h-10 items-center gap-2 rounded-md px-3 text-sm hover:bg-[var(--soft)] sm:flex"
              onClick={() => setDrawer('tasks')}
              type="button"
            >
              <ListTodo aria-hidden="true" size={17} />
              任务日志
            </button>
            <span className="hidden rounded-md bg-[var(--warning-soft)] px-3 py-2 text-sm font-semibold text-[var(--warning)] sm:inline">
              468.00 积分
            </span>
            <Button
              className="hidden sm:inline-flex"
              onClick={() => setRunRequest({ scope: 'workflow' })}
              size="sm"
              variant="inverse"
            >
              <CirclePlay aria-hidden="true" size={15} />
              运行工作流
            </Button>
            <Button size="sm">
              <Download aria-hidden="true" size={15} />
              导出
            </Button>
          </div>
        </header>

        <aside className="absolute left-3 top-[72px] z-20 hidden w-14 flex-col items-center gap-1 rounded-lg border border-[var(--border)] bg-white p-1.5 shadow-[var(--shadow-sm)] sm:flex">
          <button
            aria-label="选择工具"
            className="grid size-10 place-items-center rounded-md bg-[var(--primary-soft)] text-[var(--primary)]"
            title="选择"
            type="button"
          >
            <MousePointer2 size={18} />
          </button>
          <button
            aria-label="平移工具"
            className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
            title="平移"
            type="button"
          >
            <Move size={18} />
          </button>
          <span className="my-1 h-px w-8 bg-[var(--border)]" />
          {(
            [
              { icon: FileText, kind: 'text', title: '文本节点' },
              { icon: ImageIcon, kind: 'image', title: '图片节点' },
              { icon: Video, kind: 'video', title: '视频节点' },
            ] as const
          ).map(({ icon: Icon, kind, title }) => (
            <button
              aria-label={title}
              className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
              key={kind}
              onClick={() => addNode(kind)}
              title={title}
              type="button"
            >
              <Icon size={18} />
            </button>
          ))}
          <button
            aria-label="上传素材"
            className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
            onClick={() => addNode('asset')}
            title="上传素材"
            type="button"
          >
            <Upload size={18} />
          </button>
        </aside>

        <div className="h-[calc(100dvh-56px)]">
          <ReactFlow
            colorMode="light"
            edges={edges}
            elementsSelectable={!isMobile}
            fitView
            minZoom={0.35}
            nodeTypes={nodeTypes}
            nodes={nodes}
            nodesConnectable={!isMobile}
            nodesDraggable={!isMobile}
            onConnect={(connection) => {
              if (!isMobile) onConnect(connection);
            }}
            onEdgesChange={(changes) => {
              if (!isMobile) onEdgesChange(changes);
            }}
            onNodesChange={(changes) => {
              if (!isMobile) onNodesChange(changes);
            }}
            panOnDrag
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--canvas-grid)" gap={24} size={1} />
            <Controls position="bottom-left" />
            <MiniMap
              className="!hidden !border !border-[var(--border)] !bg-white sm:!block"
              nodeColor={nodeColor}
              pannable
              zoomable
            />
          </ReactFlow>
        </div>

        {drawer ? (
          <aside className="absolute inset-y-14 right-0 z-30 w-[min(420px,100vw)] border-l border-[var(--border)] bg-white shadow-[var(--shadow-md)]">
            <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
              <h2 className="font-bold">{drawer === 'tasks' ? '任务日志' : '版本历史'}</h2>
              <button
                aria-label="关闭抽屉"
                className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
                onClick={() => setDrawer(null)}
                type="button"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 p-4">
              {runMessage ? (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm">
                  {runMessage}
                </div>
              ) : null}
              {drawer === 'history' ? (
                <Button onClick={simulateConflict} variant="outline">
                  模拟 revision 冲突
                </Button>
              ) : (
                ['时装主视觉', '创意分析', '短片镜头'].map((item, index) => (
                  <div className="rounded-lg border border-[var(--border)] p-4" key={item}>
                    <div className="flex items-center justify-between">
                      <b className="text-sm">{item}</b>
                      <span className="text-sm text-[var(--info)]">
                        {index === 2 ? '生成中' : '成功'}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                      {index === 2 ? '刚刚开始' : '今天 15:20'} · trace 8F3A{index}
                    </p>
                  </div>
                ))
              )}
            </div>
          </aside>
        ) : null}

        <button
          className="absolute bottom-5 right-5 z-20 hidden min-h-11 items-center gap-2 rounded-md border border-[var(--border)] bg-white px-3 text-sm font-medium shadow-sm sm:flex"
          onClick={() => setDrawer('history')}
          type="button"
        >
          <History size={16} />
          版本历史
        </button>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center sm:hidden">
          <span className="rounded-md bg-[var(--inverse)] px-3 py-2 text-sm text-white">
            移动端为查看模式
          </span>
        </div>

        <Dialog onOpenChange={(open) => !open && setRunRequest(null)} open={Boolean(runRequest)}>
          <DialogContent>
            <DialogTitle className="text-xl font-bold">
              {runRequest?.scope === 'workflow' ? '确认运行工作流' : '确认运行节点'}
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
              编译校验通过后只确认一次费用，不会逐节点重复确认。
            </DialogDescription>
            <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4">
              <div className="flex justify-between text-sm">
                <span>预计总积分</span>
                <b className="text-[var(--warning)]">
                  {runRequest?.scope === 'workflow' ? '18.00' : '4.00'}
                </b>
              </div>
              <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                失败自动退还；结果未知时进入人工复核，不会自动重投。
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setRunRequest(null)} variant="ghost">
                取消
              </Button>
              <Button onClick={executeRun}>确认并运行</Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog
          onOpenChange={(open) => !open && setRemoteSnapshot(null)}
          open={Boolean(remoteSnapshot)}
        >
          <DialogContent>
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <AlertTriangle className="text-[var(--warning)]" size={20} />
              画布已在其他窗口更新
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
              重新加载可获取最新版本；另存副本会保留当前编辑。
            </DialogDescription>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={saveAsCopy} variant="outline">
                另存副本
              </Button>
              <Button onClick={loadRemoteSnapshot}>重新加载</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </CanvasActionsContext.Provider>
  );
}

export function CanvasEditorPage() {
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <CanvasEditorInner />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}

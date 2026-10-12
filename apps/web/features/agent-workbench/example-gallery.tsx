'use client';

import Image from 'next/image';
import { ImageIcon, Maximize2, RefreshCw, WandSparkles } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { showcaseExamples, type ShowcaseExample } from './showcase-data';

function ShowcaseImage({
  example,
  preview = false,
}: {
  example: ShowcaseExample;
  preview?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-sm text-[var(--muted-foreground)]"
        role="status"
      >
        <ImageIcon aria-hidden="true" size={24} />
        图片暂时无法显示
      </div>
    );
  }
  return (
    <Image
      alt={example.alt}
      className="object-contain"
      fill
      loading={preview ? 'eager' : 'lazy'}
      onError={() => setFailed(true)}
      sizes={
        preview
          ? '(max-width: 860px) 100vw, 860px'
          : '(max-width: 768px) 50vw, (max-width: 1280px) 25vw, 280px'
      }
      src={example.imageUrl}
      unoptimized
    />
  );
}

export function ExampleGallery({
  onSelect,
  availableSkills,
}: {
  onSelect: (example: ShowcaseExample) => void;
  availableSkills: readonly { primary_skill_id: string }[];
}) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ShowcaseExample | null>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const visibleExamples = Array.from(
    { length: Math.min(4, showcaseExamples.length) },
    (_, index) => showcaseExamples[(index + offset) % showcaseExamples.length]!,
  );
  const selectable =
    selected &&
    availableSkills.some((skill) => skill.primary_skill_id.split('@')[0] === selected.skillSlug);

  return (
    <section className="mt-10" aria-labelledby="example-heading">
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 className="text-[19px] font-semibold" id="example-heading">
          创作精选
        </h2>
        <button
          className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-[var(--muted-foreground)] hover:bg-[var(--soft)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          disabled={showcaseExamples.length === 0}
          onClick={() => setOffset((current) => (current + 4) % showcaseExamples.length)}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={15} />
          换一批
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-5 md:grid-cols-4 md:gap-x-4">
        {visibleExamples.map((example) => (
          <button
            aria-label={`预览${example.label}：${example.skillName}`}
            className="group min-w-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2"
            key={example.id}
            onClick={(event) => {
              selectedTrigger.current = event.currentTarget;
              setSelected(example);
            }}
            type="button"
          >
            <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-[var(--soft)] transition-[box-shadow,transform] duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[var(--shadow-media)] motion-reduce:transition-none">
              <ShowcaseImage example={example} key={example.id} />
              <span className="absolute bottom-2 right-2 grid size-9 place-items-center rounded-md bg-[var(--surface)] text-[var(--foreground)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                <Maximize2 aria-hidden="true" size={16} />
              </span>
            </div>
            <div className="pt-2.5">
              <p className="text-[14px] font-semibold">{example.skillName}</p>
              <p className="mt-0.5 text-[13px] text-[var(--muted-foreground)]">{example.label}</p>
            </div>
          </button>
        ))}
      </div>
      {showcaseExamples.length === 0 && (
        <p className="py-8 text-sm text-[var(--muted-foreground)]">暂无精选作品</p>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[860px] flex-col gap-3 overflow-y-auto p-4 sm:p-6"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            selectedTrigger.current?.focus();
          }}
        >
          {selected && (
            <>
              <div className="pr-12">
                <DialogTitle className="text-base font-semibold">{selected.label}</DialogTitle>
                <DialogDescription className="mt-1 text-sm text-[var(--muted-foreground)]">
                  {selected.skillName}
                </DialogDescription>
              </div>
              <div className="relative h-[min(65dvh,680px)] min-h-40 shrink-0 bg-[var(--soft)]">
                <ShowcaseImage example={selected} key={selected.id} preview />
              </div>
              {selectable && (
                <Button
                  className="min-h-11 self-end"
                  onClick={() => {
                    onSelect(selected);
                    setSelected(null);
                  }}
                  type="button"
                >
                  <WandSparkles aria-hidden="true" size={16} />
                  使用此 Skill
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

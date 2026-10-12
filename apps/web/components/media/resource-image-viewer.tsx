'use client';

import { LoaderCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Lightbox, { type Slide } from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { artifactAccessUrl, assetAccessUrl } from '@/lib/resource-api';

export type ViewableImage = {
  alt: string;
  height?: number | null;
  id: string;
  previewUrl?: string;
  resourceType?: 'artifact' | 'asset';
  width?: number | null;
};

type ViewerGallery = {
  index: number;
  items: ViewableImage[];
};

type ImageViewerContextValue = {
  open: (items: readonly ViewableImage[], index?: number) => void;
};

const ImageViewerContext = createContext<ImageViewerContextValue | null>(null);

async function originalImage(item: ViewableImage): Promise<Slide> {
  let src: string | undefined;
  if (item.resourceType === 'asset') {
    src = (await assetAccessUrl(item.id, 'original', 'preview')).url;
  } else if (item.resourceType === 'artifact') {
    src = (await artifactAccessUrl(item.id, 'original', 'preview')).url;
  } else {
    src = item.previewUrl;
  }
  if (!src) throw new Error('图片原图暂时不可用');
  return {
    src,
    alt: item.alt,
    ...(item.width && item.width > 0 ? { width: item.width } : {}),
    ...(item.height && item.height > 0 ? { height: item.height } : {}),
  };
}

export function ResourceImageViewerProvider({ children }: { children: ReactNode }) {
  const [gallery, setGallery] = useState<ViewerGallery | null>(null);
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const close = useCallback(() => {
    setGallery(null);
    setSlides(null);
    setSlideIndex(0);
    setLoadError('');
  }, []);

  const open = useCallback((items: readonly ViewableImage[], index = 0) => {
    const available = items.filter((item) => item.resourceType || item.previewUrl);
    if (available.length === 0) return;
    setSlides(null);
    setSlideIndex(0);
    setLoadError('');
    setGallery({
      items: available,
      index: Math.min(Math.max(index, 0), available.length - 1),
    });
  }, []);

  useEffect(() => {
    if (!gallery) return undefined;
    let active = true;
    setSlides(null);
    setLoadError('');
    void Promise.allSettled(gallery.items.map(originalImage))
      .then((results) => {
        const selected = results[gallery.index];
        if (!selected || selected.status === 'rejected') {
          throw selected?.reason ?? new Error('当前图片原图暂时不可用');
        }
        const nextSlides = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const nextIndex = results
          .slice(0, gallery.index)
          .filter((result) => result.status === 'fulfilled').length;
        if (active) {
          setSlideIndex(nextIndex);
          setSlides(nextSlides);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : '原图加载失败，请重试');
        }
      });
    return () => {
      active = false;
    };
  }, [attempt, gallery]);

  const value = useMemo<ImageViewerContextValue>(() => ({ open }), [open]);
  const waiting = Boolean(gallery && !slides);

  return (
    <ImageViewerContext.Provider value={value}>
      {children}
      <Dialog
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
        open={waiting}
      >
        <DialogContent className="w-[min(calc(100vw-32px),420px)] p-6">
          <DialogTitle className="sr-only">打开图片查看器</DialogTitle>
          <div className="grid min-h-32 place-items-center text-center">
            {loadError ? (
              <div>
                <p className="text-sm text-[var(--foreground)]">{loadError}</p>
                <Button
                  className="mt-4"
                  onClick={() => setAttempt((value) => value + 1)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  重试
                </Button>
              </div>
            ) : (
              <div className="text-sm text-[var(--muted-foreground)]">
                <LoaderCircle aria-hidden="true" className="mx-auto mb-3 animate-spin" size={22} />
                正在加载原图…
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Lightbox
        animation={{ fade: 160, navigation: 220, swipe: 240, zoom: 180 }}
        carousel={{ finite: true, padding: '24px', spacing: '24px' }}
        className="resource-image-viewer"
        close={close}
        controller={{
          closeOnBackdropClick: true,
          closeOnEscape: true,
          closeOnPullDown: true,
          closeOnPullUp: true,
        }}
        index={slideIndex}
        labels={{
          Carousel: '图片画廊',
          Close: '关闭图片查看器',
          Lightbox: '图片查看器',
          Next: '下一张图片',
          Previous: '上一张图片',
          Slide: '图片',
          'Photo gallery': '图片画廊',
          'Zoom in': '放大图片',
          'Zoom out': '缩小图片',
          '{index} of {total}': '第 {index} 张，共 {total} 张',
        }}
        open={Boolean(gallery && slides)}
        plugins={[Zoom]}
        slides={slides ?? []}
        toolbar={{ buttons: ['zoom', 'close'] }}
        zoom={{
          doubleClickMaxStops: 3,
          maxZoomPixelRatio: 5,
          pinchZoomV4: true,
          scrollToZoom: true,
          zoomInMultiplier: 2,
        }}
        {...(slides && slides.length <= 1
          ? { render: { buttonNext: () => null, buttonPrev: () => null } }
          : {})}
      />
    </ImageViewerContext.Provider>
  );
}

export function useResourceImageViewer(): ImageViewerContextValue {
  const value = useContext(ImageViewerContext);
  if (!value)
    throw new Error('useResourceImageViewer must be used inside ResourceImageViewerProvider');
  return value;
}

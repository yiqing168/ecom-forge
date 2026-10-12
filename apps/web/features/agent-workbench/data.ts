import { ImageIcon, Palette, Shirt } from 'lucide-react';

export const creationModes = [
  {
    icon: Shirt,
    id: 'white-background',
    label: '白底精修',
    prompt: '把这件商品处理成干净的电商白底主图，保留商品颜色、Logo 和完整结构',
  },
  {
    icon: ImageIcon,
    id: 'hero-image',
    label: '主图创意',
    prompt: '为这个商品生成一张有明确卖点层级的电商主图，主体突出，画面克制',
  },
  {
    icon: Palette,
    id: 'style-transfer',
    label: '风格转译',
    prompt: '学习参考图的光线、配色和构图，生成同风格但内容全新的图片',
  },
] as const;

export type ExampleAsset = {
  category: string;
  id: string;
  imageUrl: string;
  label: string;
  prompt: string;
  tags: string;
  resourceType?: 'asset' | 'artifact';
  resourceVersion?: string;
};

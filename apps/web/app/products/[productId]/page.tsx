import { ProductDetailPage } from '@/features/product-pages/library-pages';

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <ProductDetailPage productId={productId} />;
}

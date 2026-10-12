import { DiscoverDetailPage } from '@/features/product-pages/growth-pages';
export default async function Page({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  return <DiscoverDetailPage itemId={itemId} />;
}

import PropertyView from "@/components/PropertyView";

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PropertyView propertyId={id} />;
}

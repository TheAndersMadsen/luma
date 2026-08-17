import MemoryDetailView from "./MemoryDetailView";

/*
 * One capture, as the Pin holds it.
 *
 * A server component only to unwrap the route parameter — everything real here
 * needs the WebUSB session, which exists solely in the browser. The uuid is
 * passed through unvalidated on purpose: the view has to be able to SAY that a
 * device answered with an identifier it cannot address, and a redirect or a
 * notFound() here would replace that sentence with a blank 404.
 */
export default async function PinMemoryDetailPage({
  params,
}: {
  params: Promise<{ uuid: string }>;
}) {
  const { uuid } = await params;

  return <MemoryDetailView uuid={uuid} />;
}

import { Workspace } from "@/components/Workspace";

export default function DocPage({ params }: { params: { id: string } }) {
  return <Workspace docId={params.id} />;
}

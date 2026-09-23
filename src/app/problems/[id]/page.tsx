import PracticeWorkspace from '../../../components/PracticeWorkspace';

export default async function ProblemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return (
    <PracticeWorkspace problemId={id} initialTab={tab === 'solution' ? 'solution' : 'question'} />
  );
}

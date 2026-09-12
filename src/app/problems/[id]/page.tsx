import App from '../../../App';

export default async function ProblemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <App problemId={id} initialTab={tab === 'solution' ? 'solution' : 'question'} />;
}

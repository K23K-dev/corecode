import type { TestCase } from './practice-runner';

export interface Exercise {
  version?: string;
  id: string;
  title: string;
  deckId: string;
  deck: string;
  language: string;
  extension: string;
  difficulty: string;
  prompt: string;
  starterCode: string;
  referenceCode: string;
  runtime?: 'browser-python' | 'python' | 'javascript' | 'sql' | 'shell';
  supportsCustomInput?: boolean;
  explanation?: string;
  solutionAlternatives?: {
    title: string;
    explanation: string;
    code: string;
    complexity?: string;
  }[];
  example?: string;
  topic?: string;
  requirements?: string[];
  examples?: { input: string; output: string }[];
  entryPoint?: string;
  customInput?: string;
  cases?: TestCase[];
}

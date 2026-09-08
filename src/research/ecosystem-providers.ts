import { GitHubProvider } from '../providers/github.js';
import { HuggingFaceProvider } from '../providers/huggingface.js';

export function createEcosystemProviders() {
  return {github:new GitHubProvider(), huggingface:new HuggingFaceProvider()};
}

/** Profile settings shared by the browser UI and the Host executor. */
export interface WebLimits {
  maxRounds: number
  noProgressRounds: number
  maxObserveRounds: number
  maxScrollCandidates: number
  maxCandidates: number
  historySteps: number
  evidenceChars: number
  scrollPixels: number
  resultSteps: number
}

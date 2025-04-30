import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

import { KaiModifiedFile } from "../types";

const arrayReducer = <T>(left: T[], right: T | T[]): T[] => {
  if (Array.isArray(right)) {
    return left.concat(right);
  }
  return left.concat([right]);
};

export const AnalysisIssueFixInputMetaState = Annotation.Root({
  migrationHint: Annotation<string>,
  programmingLanguage: Annotation<string>,
});

export const AdditionalInfoSummarizeInputState = Annotation.Root({
  ...AnalysisIssueFixInputMetaState.spec,
  previousResponse: Annotation<string>,
});

export const AdditionalInfoSummarizeOutputState = Annotation.Root({
  additionalInformation: Annotation<string>,
});

export const AddressAdditionalInfoInputState = Annotation.Root({
  ...MessagesAnnotation.spec,
  ...AnalysisIssueFixInputMetaState.spec,
  ...AdditionalInfoSummarizeOutputState.spec,
});

export const AddressAdditionalInfoOutputState = Annotation.Root({
  ...MessagesAnnotation.spec,
  modifiedFiles: Annotation<KaiModifiedFile[]>({
    reducer: arrayReducer,
    default: () => [],
  }),
});

export const AnalysisIssueFixOverallState = Annotation.Root({
  ...AdditionalInfoSummarizeInputState.spec,
  ...AdditionalInfoSummarizeOutputState.spec,
  ...AddressAdditionalInfoInputState.spec,
  ...AddressAdditionalInfoOutputState.spec,
});

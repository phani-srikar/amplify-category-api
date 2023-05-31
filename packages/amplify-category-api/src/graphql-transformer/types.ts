export type ConstructResourceMeta = {
  rootStack?: StackMeta;
  nestedStack?: StackMeta;
  resourceName: string;
  resourceType: string;
};

export type OverrideConfig = {
  overrideFlag: boolean;
  overrideDir: string;
  resourceName: string;
};

export type StackMeta = {
  stackName: string;
  stackType: string;
};

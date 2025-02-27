import {
  GraphQLSchema,
  concatAST,
  Kind,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from "graphql";

import {
  Types,
  PluginFunction,
  oldVisit,
} from "@graphql-codegen/plugin-helpers";
import {
  ClientSideBaseVisitor,
  LoadedFragment,
} from "@graphql-codegen/visitor-plugin-common";
import pascalCase from "just-pascal-case";

// The main codegen plugin.
export const plugin: PluginFunction<any> = (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config
) => {
  // Get all graphql documents
  const allAst = concatAST(documents.map((d) => d.document));

  // Get all fragments
  const allFragments: LoadedFragment[] = [
    ...(
      allAst.definitions.filter(
        (d) => d.kind === Kind.FRAGMENT_DEFINITION
      ) as FragmentDefinitionNode[]
    ).map((fragmentDef) => ({
      node: fragmentDef,
      name: fragmentDef.name.value,
      onType: fragmentDef.typeCondition.name.value,
      isExternal: false,
    })),
    ...(config.externalFragments || []),
  ];

  //   Create the visitor
  const visitor = new ClientSideBaseVisitor(
    schema,
    allFragments,
    config,
    { documentVariableSuffix: "Doc" },
    documents
  );

  //   Visit all the documents
  const visitorResult = oldVisit(allAst, { leave: visitor });

  // Filter out the operations
  const operations = allAst.definitions.filter(
    (d) => d.kind === Kind.OPERATION_DEFINITION
  ) as OperationDefinitionNode[];

  //   The default required types. These should probably live somewhere else and be imported
  //   TODO: move to a file
  const defaultTypes = `

type FetchWrapperArgs<T> = {
	fetch: typeof fetch,
	variables?: T,
}

type SubscribeWrapperArgs<T> = {
	variables?: T,
}

interface CacheFunctionOptions {
	update?: boolean
}
`;

  // This is where the string that will be written to .gq files is created
  const ops = operations
    .map((o) => {
      if (o) {
        const name = o?.name?.value || "";
        const op = `${pascalCase(name)}${pascalCase(o.operation)}`;
        const pascalName = pascalCase(name);
        const opv = `${op}Variables`;
        let operations = "";

        if (o.operation === "query") {
          operations += `
export const ${name} = writable<GFetchReturnWithErrors<${op}>>()

// Cached
export async function get${pascalName}({ fetch, variables }: GGetParameters<${opv}>, options?: CacheFunctionOptions) {
	const data = await g.fetch<${op}>({
		queries: [{ query: ${pascalName}Doc, variables }],
		fetch
	})
	await ${name}.set({ ...data, errors: data?.errors, gQueryStatus: 'LOADED' })	
	return data
}

`;
        } else if (o.operation === "mutation") {
          // This is where the mutation code is generated
          // We're grabbing the mutation name and using it as a string in the generated code
          operations += `
export const ${name} = ({ variables }: SubscribeWrapperArgs<${opv}>):
Promise<GFetchReturnWithErrors<${op}>> =>
	g.fetch<${op}>({
		queries: [{ query: ${pascalName}Doc, variables }],
		fetch,
	})
`;
        }

        return operations;
      }
    })
    .join("\n");

  // The imports that are included at the top of the generated file
  const imports = [
    `import { writable } from "svelte/store"`,
    `import { g } from '${config.gPath}'`,
    `import type { GFetchReturnWithErrors, GGetParameters } from '@leveluptuts/g-query'`,
  ];

  return {
    prepend: [...imports, ...visitor.getImports()],
    content: [
      defaultTypes,
      visitor.fragments,
      ...visitorResult.definitions.filter((t) => typeof t == "string"),
      ops,
    ].join("\n"),
  };
};
// TODO
// - add option to force update of cache. ie getUserTutorials({update: true})
// if update.true is not set, then it will only update if the cache is empty

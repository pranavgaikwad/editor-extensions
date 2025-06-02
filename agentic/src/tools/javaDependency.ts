import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

interface MavenResponseDoc {
  g: string;
  a: string;
  latestVersion?: string;
}

interface MavenApiResponse {
  response: {
    docs: MavenResponseDoc[];
  };
}

export class JavaDependencyTools {
  all(): DynamicStructuredTool[] {
    return [this.searchFQDNTool()];
  }

  private searchFQDNTool = (): DynamicStructuredTool => {
    return new DynamicStructuredTool({
      name: "searchFqdn",
      description:
        "Searches maven central repo for fully qualified domain names for Java dependencies",
      schema: z.object({
        artifactID: z.string().describe("Artifact ID of the dependency"),
        groupID: z.string().describe("Group ID of the dependency"),
        version: z.string().describe("Version of the dependency").optional(),
      }),
      func: async ({
        artifactID,
        groupID,
        version,
      }: {
        artifactID: string;
        groupID: string;
        version: string;
      }) => {
        const query = [artifactID, groupID, version]
          .filter(Boolean)
          .map((val, idx) => {
            switch (idx) {
              case 0:
                return `a:${val}`;
              case 1:
                return `g:${val}`;
              case 2:
                return `v:${val}`;
            }
          })
          .join(" AND ");
        const url = `https://search.maven.org/solrsearch/select?q=${query}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const fetchOptions: RequestInit = {
            signal: controller.signal,
          };
          const resp = await fetch(url, fetchOptions);
          if (resp.status !== 200) {
            const err = `Maven Central API returned status code: ${resp.status}`;
            console.error(err);
            return err;
          }
          const output = (await resp.json()) as MavenApiResponse;
          const docs = output?.response?.docs.filter(Boolean);

          if (!docs || docs.length === 0) {
            return `No dependencies found matching given search criteria`;
          }

          const depToString = (dep: MavenResponseDoc) =>
            `ArtifactID: ${dep.a}, GroupID: ${dep.g}${dep.latestVersion ? `, LatestVersion: ${dep.latestVersion}` : ``}`;

          if (docs.length > 1) {
            return docs.map((d) => depToString(d)).join("\n - ");
          } else if (docs.length === 1) {
            return depToString(docs[0]);
          } else {
            return `No dependencies found matching given search criteria`;
          }
        } catch (error: any) {
          if (error.name === "AbortError") {
            console.error("Request to Maven Central timed out.");
          } else {
            console.error("Error fetching from Maven Central:", error);
          }
          return `Encountered error retrieving dependencies: ${String(error)}`;
        } finally {
          clearTimeout(timeoutId);
        }
      },
    });
  };
}

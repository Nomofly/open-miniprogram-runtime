import { readFile } from "node:fs/promises";
import path from "node:path";

export interface SubPackage {
  root: string;
  pages: string[];
  name?: string;
  independent?: boolean;
}

/** The app.json fields this project uses; other fields are kept as is. */
export interface AppJson {
  pages: string[];
  entryPagePath?: string;
  subpackages?: SubPackage[];
  subPackages?: SubPackage[];
  [key: string]: unknown;
}

export interface MiniProgramProject {
  /** Absolute path of the project directory, which holds project.config.json when there is one. */
  dir: string;
  /** `appid` from project.config.json, or `touristappid` when it is not set. */
  appid: string;
  /** `projectname` from project.config.json, or the directory name. */
  name: string;
  /** Absolute path of the Mini Program root, the directory that contains app.json. */
  root: string;
  appJson: AppJson;
  /** Every page path in the main package and subpackages, without extension, such as `packageA/pages/cat/cat`. */
  pages: string[];
  /** The launch page: `entryPagePath`, or the first entry of `pages` when it is not set. */
  entryPage: string;
}

/**
 * Loads a Mini Program project. `dir` is either the directory that contains
 * app.json, or a project directory with a project.config.json whose
 * `miniprogramRoot` points to it.
 */
export async function loadProject(dir: string): Promise<MiniProgramProject> {
  const projectConfig = await readJson(path.join(dir, "project.config.json"));
  const miniprogramRoot =
    typeof projectConfig?.miniprogramRoot === "string" ? projectConfig.miniprogramRoot : "";
  const root = path.resolve(dir, miniprogramRoot);

  const appJsonPath = path.join(root, "app.json");
  const appJson = (await readJson(appJsonPath)) as AppJson | undefined;
  if (!appJson) {
    throw new Error(`app.json not found: ${appJsonPath}`);
  }
  if (!Array.isArray(appJson.pages) || appJson.pages.length === 0) {
    throw new Error(`app.json must list at least one page in "pages": ${appJsonPath}`);
  }

  const subPackages = appJson.subPackages ?? appJson.subpackages ?? [];
  const pages = [
    ...appJson.pages,
    ...subPackages.flatMap((pkg) => pkg.pages.map((page) => path.posix.join(pkg.root, page))),
  ];

  return {
    dir: path.resolve(dir),
    appid: typeof projectConfig?.appid === "string" ? projectConfig.appid : "touristappid",
    name:
      typeof projectConfig?.projectname === "string"
        ? decodeURIComponent(projectConfig.projectname)
        : path.basename(path.resolve(dir)),
    root,
    appJson,
    pages,
    entryPage: appJson.entryPagePath ?? appJson.pages[0]!,
  };
}

export async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

import colors from 'colors/safe.js'
import type {Request, Response} from 'express'
import {Agent} from 'node:https'
import {join} from 'path'
import {createClient, type FileStat, type WebDAVClient} from 'webdav'
import {z} from 'zod'
import {fromZodError} from 'zod-validation-error'
import {logger} from '../logger.js'
import type {IStorage} from './base.storage.js'

const storageConfigSchema = z.object({
  url: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  basePath: z.string(),
})

export class WebdavStorage implements IStorage {
  protected readonly client: WebDAVClient
  protected readonly storageConfig: z.infer<typeof storageConfigSchema>
  protected readonly basePath: string

  constructor(
    storageConfig: unknown,
  ) {
    try {
      this.storageConfig = storageConfigSchema.parse(storageConfig)
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new Error('webdav存储选项无效', {cause: fromZodError(e)})
      } else {
        throw new Error('webdav存储选项无效', {cause: e})
      }
    }
    this.client = createClient(
      this.storageConfig.url,
      {
        username: this.storageConfig.username,
        password: this.storageConfig.password,
        httpsAgent: new Agent({rejectUnauthorized: false}),
      },
    )
    this.basePath = this.storageConfig.basePath
  }

  public async init(): Promise<void> {
    if (!await this.client.exists(this.basePath)) {
      logger.info(`create base path: ${this.basePath}`)
      await this.client.createDirectory(this.basePath, {recursive: true})
    }
  }

  public async writeFile(path: string, content: Buffer): Promise<void> {
    await this.client.putFileContents(join(this.basePath, path), content)
  }

  public async exists(path: string): Promise<boolean> {
    return this.client.exists(join(this.basePath, path))
  }

  public getAbsolutePath(path: string): string {
    return this.client.getFileDownloadLink(join(this.basePath, path))
  }


  public async getMissingFiles<T extends {path: string; hash: string}>(files: T[]): Promise<T[]> {
    const manifest = new Map<string, T>()
    for (const file of files) {
      manifest.set(file.hash, file)
    }
    const queue = [this.basePath]
    do {
      const dir = queue.pop()
      if (!dir) break
      const entries = await this.client.getDirectoryContents(dir) as FileStat[]
      for (const entry of entries) {
        if (entry.type === 'directory') {
          queue.push(entry.filename)
          continue
        }
        if (manifest.has(entry.basename)) {
          manifest.delete(entry.basename)
        }
      }
    } while (queue.length !== 0)
    return [...manifest.values()]
  }

  public async gc(files: {path: string; hash: string; size: number}[]): Promise<void> {
    const fileSet = new Set<string>()
    for (const file of files) {
      fileSet.add(file.hash)
    }
    const queue = [this.basePath]
    do {
      const dir = queue.pop()
      if (!dir) break
      const entries = await this.client.getDirectoryContents(dir) as FileStat[]
      for (const entry of entries) {
        if (entry.type === 'directory') {
          queue.push(entry.filename)
          continue
        }
        if (!fileSet.has(entry.basename)) {
          logger.info(colors.gray(`delete expire file: ${entry.filename}`))
          await this.client.deleteFile(entry.filename)
        }
      }
    } while (queue.length !== 0)
  }

  public async express(hashPath: string, req: Request, res: Response): Promise<{ bytes: number; hits: number }> {
    const path = join(this.basePath, hashPath)
    const file = this.client.getFileDownloadLink(path)
    res.redirect(file)
    return {bytes: 0, hits: 1}
  }
}
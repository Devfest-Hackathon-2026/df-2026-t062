// Explicit evaluation only: caller must supply the synthetic case's checked reply.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatReply } from '../../api/chat.ts'
import { diagramImage } from '../../api/diagram-image.ts'
import { diagramDocument, diagramSchema, validDiagramUpdate } from '../../core/diagram/fields.ts'
import { diagramSvg } from '../../core/diagram/svg.ts'

export async function saveDiagramArtifacts(name: string, reply: ChatReply, directory: string): Promise<string[]> {
  assert.match(name, /^[a-z0-9-]+$/)
  await mkdir(directory, { recursive: true })
  const paths: string[] = []
  for (const proposal of reply.proposals) {
    const value = diagramSchema.parse(proposal.after)
    assert.ok(validDiagramUpdate(proposal.key, value, proposal.before), 'Invalid diagram or revision')
    const bodyImage = `data:image/png;base64,${(await readFile(new URL('../../core/diagram/body.png', import.meta.url))).toString('base64')}`
    const svg = diagramSvg(diagramDocument(value), value.kind, { cropBody: true, bodyImage })
    assert.match(svg, /<svg/)
    const image = await diagramImage(value, 600, 450)
    const prefix = join(directory, `${name}-${value.kind}`)
    await writeFile(`${prefix}.svg`, svg)
    await writeFile(`${prefix}.png`, Buffer.from(image.split(',')[1], 'base64'))
    paths.push(`${prefix}.svg`, `${prefix}.png`)
  }
  const path = join(directory, `${name}.json`)
  await writeFile(path, JSON.stringify(reply, null, 2))
  return [...paths, path]
}

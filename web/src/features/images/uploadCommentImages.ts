import { api } from '../../lib/api'

/** Uploads files one by one to a comment. The file name is the caption. */
export async function uploadCommentImages(slug: string, target: 'issues' | 'milestones', targetId: string, commentId: string, files: File[]) {
  for (const file of files) {
    const form = new FormData()
    form.append('caption', file.name)
    form.append('comment_id', commentId)
    form.append('file', file)
    await api.post(`/w/${encodeURIComponent(slug)}/${target}/${encodeURIComponent(targetId)}/images`, form)
  }
}

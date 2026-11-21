import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSharedNoriClient, type CourseProgressResponse, type LessonProgress } from '../index'
import { useNoriConnection } from './connection'
import { IconListChecks, IconWifi, IconWifiOff } from './icons'

export type NoriProgressLesson = {
  key: string
  title?: string
  href?: string
  /** Exercises in the lesson's bank, to show "attempted of total". */
  exerciseCount?: number
}

export type NoriProgressProps = {
  courseKey: string
  /** The course's lessons in reading order; lessons without attempts show as untouched. Without it, only practised lessons are listed. */
  lessons?: NoriProgressLesson[]
  apiBaseUrl?: string
  title?: string
}

type Row = { lesson: NoriProgressLesson; progress: LessonProgress | null }

/** Joins the sidecar's per-lesson rows to the course's lesson list, keeping the list's order. */
export function progressRows(lessons: NoriProgressLesson[] | undefined, progress: LessonProgress[]): Row[] {
  const byKey = new Map(progress.map((p) => [p.lessonKey, p]))
  if (!lessons) return progress.map((p) => ({ lesson: { key: p.lessonKey }, progress: p }))
  const listed = new Set(lessons.map((l) => l.key))
  return [
    ...lessons.map((lesson) => ({ lesson, progress: byKey.get(lesson.key) ?? null })),
    // Practised lessons missing from the list (renamed or course-level banks) still show.
    ...progress.filter((p) => !listed.has(p.lessonKey)).map((p) => ({ lesson: { key: p.lessonKey }, progress: p })),
  ]
}

function formatWhen(ts: number, now: number): string {
  const days = Math.floor((now - ts) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(ts).toISOString().slice(0, 10)
}

export function NoriProgress({ courseKey, lessons, apiBaseUrl = '/api/nori/v1', title = 'Course progress' }: NoriProgressProps) {
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const [data, setData] = useState<CourseProgressResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await client.getProgress(courseKey, signal)
        if (signal?.aborted) return
        setData(res)
        setError(null)
      } catch (e) {
        if (signal?.aborted) return
        // Network failures show in the status badge; an old sidecar or a bad key is worth saying.
        if (e instanceof Error && e.name !== 'NoriNetworkError') setError(e.message)
      }
    },
    [client, courseKey],
  )

  const online = useNoriConnection(client, () => {
    load()
  })

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUpdated = () => load()
    window.addEventListener('nori:practice-updated', onUpdated)
    return () => window.removeEventListener('nori:practice-updated', onUpdated)
  }, [load])

  const rows = data ? progressRows(lessons, data.lessons) : []

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <div className="nori-practice__title-group">
          <span className="nori-header-icon">
            <IconListChecks />
          </span>
          <h3 className="nori-practice__title">{title}</h3>
          {data && (
            <span className={`nori-badge ${data.totals.exercisesDue > 0 ? 'nori-badge--warn' : 'nori-badge--correct'}`}>
              {data.totals.exercisesDue} due
            </span>
          )}
        </div>
        <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
          {online === 'online' ? <IconWifi /> : <IconWifiOff />}
          <span>{online === 'online' ? 'Nori progress synced' : online === 'offline' ? 'Offline' : 'Checking sidecar…'}</span>
        </span>
      </header>

      {error && <p className="nori-error">{error}</p>}

      {data && (
        <div className="nori-card">
          {rows.length === 0 ? (
            <p className="nori-muted">No practice recorded for this course yet.</p>
          ) : (
            <table className="nori-progress">
              <thead>
                <tr>
                  <th scope="col">Lesson</th>
                  <th scope="col">Attempted</th>
                  <th scope="col">Correct</th>
                  <th scope="col">Due</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ lesson, progress }) => {
                  const label = lesson.title ?? (lesson.key || 'Course-level exercises')
                  return (
                    <tr key={lesson.key} data-lesson-key={lesson.key} className={progress ? undefined : 'nori-progress__untouched'}>
                      <th scope="row">{lesson.href ? <a href={lesson.href}>{label}</a> : label}</th>
                      <td>
                        {progress?.exercisesAttempted ?? 0}
                        {lesson.exerciseCount !== undefined && ` / ${lesson.exerciseCount}`}
                      </td>
                      <td>{progress?.exercisesCorrect ?? 0}</td>
                      <td className={progress && progress.exercisesDue > 0 ? 'nori-progress__due' : undefined}>{progress?.exercisesDue ?? 0}</td>
                      <td>{progress ? formatWhen(progress.lastActivityAt, data.serverNow) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <p className="nori-muted">
            {data.totals.exercisesAttempted} exercise(s) attempted across {data.totals.attempts} attempt(s). Correct counts exercises whose latest
            graded attempt was right; open-ended answers are not graded.
          </p>
        </div>
      )}
    </section>
  )
}

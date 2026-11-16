Bun.serve({
  hostname: '127.0.0.1', port: 3174,
  async fetch(request) {
    if (request.method === 'GET') return new Response('ok')
    const body = await request.json() as { messages: { content: string }[] }
    if (body.messages.some((message) => message.content.includes('slow test'))) await Bun.sleep(300)
    const outline = body.messages[0]?.content.includes('Create a concise structured course outline')
    const module1 = body.messages[0]?.content.includes('Create the first module')
    const module2 = body.messages[0]?.content.includes('Create module 2')
    const feedback = body.messages[0]?.content.includes('Give constructive')
    const content = module2
      ? JSON.stringify({
          title: 'Advanced application',
          lessons: [{ title: 'Deep dive', body: 'Deep dive into application.' }],
          exercises: [
            { type: 'multiple_choice', prompt: 'Select the optimal strategy', options: ['Strategy A', 'Strategy B'], answer: 'Strategy A', explanation: 'Strategy A is optimal.' },
            { type: 'written', prompt: 'Describe the tradeoffs', options: [], answer: 'Tradeoff analysis', explanation: 'Analyze tradeoffs.' },
            { type: 'code', prompt: 'Implement the algorithm', options: [], answer: 'function solve() { return true; }', explanation: 'Algorithm implementation.' },
          ],
        })
      : module1
      ? JSON.stringify({
          title: 'First principles',
          lessons: [{ title: 'Foundations', body: 'Learn the foundations.' }],
          exercises: [
            { type: 'multiple_choice', prompt: 'Choose the correct answer', options: ['A', 'B'], answer: 'A', explanation: 'A is correct.' },
            { type: 'written', prompt: 'Explain the idea', options: [], answer: 'A good explanation', explanation: 'Explain the idea.' },
            { type: 'code', prompt: 'Write a function', options: [], answer: 'A correct function', explanation: 'Use a function.' },
          ],
        })
      : outline
      ? `Module 1: First principles\nLesson: Foundations\nExercise: Explain the concept\n${body.messages.some((message) => message.content.includes('A reliable foundation.')) ? 'Source: notes.md' : 'No source received'}`
      : feedback
      ? 'Consider the core idea and add an example.'
      : 'What experience do you already have?'
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  },
})

import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  return NextResponse.json({
    success: true,
    data: {
      id,
      status: 'unfulfilled',
      customerEmail: 'james@example.com',
      customerName: 'James Taylor',
      totalPence: 42000,
      lineItems: [],
      createdAt: new Date().toISOString(),
      message: 'Connect Neon DB.',
    },
  })
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const body = await req.json()

  return NextResponse.json({
    success: true,
    data: { id, ...body },
  })
}

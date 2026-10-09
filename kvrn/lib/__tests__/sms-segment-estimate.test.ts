import {estimateSmsSegments} from '../sms-segment-estimate'
describe('SMS draft-only segment estimate',()=>{
  test('GSM basic: 160 one segment; 161 two concatenated',()=>{
    expect(estimateSmsSegments('a'.repeat(160))).toMatchObject({encoding:'GSM-7',units:160,segments:1})
    expect(estimateSmsSegments('a'.repeat(161))).toMatchObject({encoding:'GSM-7',units:161,segments:2})
  })
  test('GSM extended characters use two septets',()=>{
    expect(estimateSmsSegments('^'.repeat(80))).toMatchObject({encoding:'GSM-7',units:160,segments:1})
    expect(estimateSmsSegments('^'.repeat(81))).toMatchObject({encoding:'GSM-7',units:162,segments:2})
  })
  test('UCS-2 astral emoji count UTF-16 units',()=>{
    expect(estimateSmsSegments('😀'.repeat(35))).toMatchObject({encoding:'UCS-2',units:70,segments:1})
    expect(estimateSmsSegments('😀'.repeat(36))).toMatchObject({encoding:'UCS-2',units:72,segments:2})
  })
  test('Unicode turns the entire draft into UCS-2',()=>{
    expect(estimateSmsSegments('Hi 😀')).toMatchObject({encoding:'UCS-2',units:5,segments:1})
  })
  test('Empty message estimates no segments',()=>expect(estimateSmsSegments('')).toMatchObject({segments:0,units:0}))
})

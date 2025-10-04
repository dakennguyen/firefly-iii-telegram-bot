import dayjs from 'dayjs'
import Debug from 'debug'
import { Composer, InlineKeyboard } from 'grammy'
import { table, getBorderCharacters } from 'table'

import type { MyContext } from '../types/MyContext'
import i18n, { locales } from '../lib/i18n'
import { reportsMapper as mapper } from './helpers'
import firefly from '../lib/firefly'
import { handleCallbackQueryError } from '../lib/errorHandler'
import { InsightGroupEntry } from '../lib/firefly/model/insight-group-entry'

const debug = Debug(`bot:reports`)

const bot = new Composer<MyContext>()

for (const locale of locales) {
  bot.hears(i18n.t(locale, 'labels.REPORTS'), showReport)
}
bot.callbackQuery(mapper.list.regex(), showReport)
bot.callbackQuery(mapper.close.regex(), closeHandler)

export default bot

async function showReport(ctx: MyContext) {
  const log = debug.extend('showReport')
  log(`Entered showReport callback handler...`)
  try {
    const userSettings = ctx.session.userSettings
    const isRegularMessage = !!ctx.update.message
    log('isRegularMessage: %O', isRegularMessage)
    log('ctx.match: %O', ctx.match)

    let month: string
    
    // Check if it is a callback query or a regular message
    if (isRegularMessage) {
      month = dayjs().format('YYYY-MM')
    } else {
      await ctx.answerCallbackQuery()
      month = ctx.match![1]
    }
    log('month: %O', month)

    const startDate = dayjs(month).startOf('month').format('YYYY-MM-DD')
    const endDate = dayjs(month).endOf('month').format('YYYY-MM-DD')
    log('startDate: %O, endDate: %O', startDate, endDate)

    // Fetch expense and income data in parallel
    const [expenseData, incomeData] = await Promise.all([
      firefly(userSettings).Insight.insightExpenseCategory(startDate, endDate),
      firefly(userSettings).Insight.insightIncomeCategory(startDate, endDate)
    ])

    log('expenseData: %O', expenseData.data)
    log('incomeData: %O', incomeData.data)

    const keyboard = createReportNavigationKeyboard(ctx, month)
    const text = formatReportMessage(ctx, month, expenseData.data, incomeData.data)

    if (isRegularMessage) {
      return ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    } else {
      return ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    }
  } catch (err: any) {
    return handleCallbackQueryError(err, ctx)
  }
}

async function closeHandler(ctx: MyContext) {
  const log = debug.extend('closeHandler')
  log('ctx.session: %O', ctx.session)
  await ctx.answerCallbackQuery()
  ctx.session.deleteKeyboardMenuMessage &&
    await ctx.session.deleteKeyboardMenuMessage()
  return ctx.deleteMessage()
}

function createReportNavigationKeyboard(
  ctx: MyContext, currentMonth: string
): InlineKeyboard {
  const log = debug.extend('createReportNavigationKeyboard')
  const prevMonth = dayjs(currentMonth).subtract(1, 'month')
  const prevMonthName = prevMonth.format('MMM YYYY')
  log('prevMonthName: %O', prevMonthName)
  const nextMonth = dayjs(currentMonth).add(1, 'month')
  const nextMonthName = nextMonth.format('MMM YYYY')
  log('nextMonthName: %O', nextMonthName)

  const keyboard = new InlineKeyboard()
    .text(
      `<< ${prevMonthName}`,
      mapper.list.template({ month: prevMonth.format('YYYY-MM') })
    )
    .text(
      `${nextMonthName} >>`,
      mapper.list.template({ month: nextMonth.format('YYYY-MM') })
    ).row()
    .text(ctx.i18n.t('labels.DONE'), mapper.close.template())

  return keyboard
}

function formatCategoryData(entries: InsightGroupEntry[]) {
  const log = debug.extend('formatCategoryData')
  
  if (entries.length === 0) return ''

  const data = entries.map(entry => {
    const amount = Math.abs(entry.difference_float || 0).toFixed(2)
    const currency = entry.currency_code || '💲'
    const name = entry.name || 'Unknown'
    return [ name, `${amount} ${currency}` ]
  })

  const config = {
    border: getBorderCharacters('void'),
    columnDefault: {
        paddingLeft: 0,
        paddingRight: 1
    },
    drawHorizontalLine: () => false
  }

  log(table(data, config))
  return table(data, config)
}

function calculateTotal(entries: InsightGroupEntry[]): { [currency: string]: number } {
  const log = debug.extend('calculateTotal')
  
  const totals = entries.reduce((acc, entry) => {
    const currency = entry.currency_code || '💲'
    const amount = Math.abs(entry.difference_float || 0)
    
    if (!acc[currency]) {
      acc[currency] = amount
    } else {
      acc[currency] += amount
    }
    
    return acc
  }, {} as { [currency: string]: number })
  
  log('totals: %O', totals)
  return totals
}

function formatTotal(totals: { [currency: string]: number }): string {
  return Object.keys(totals)
    .map(currency => {
      const amount = totals[currency]
      return `${amount.toFixed(2)} ${currency}`
    })
    .join(', ')
}

function formatReportMessage(
  ctx: MyContext, 
  month: string, 
  expenseData: InsightGroupEntry[], 
  incomeData: InsightGroupEntry[]
) {
  const log = debug.extend('formatReportMessage')
  
  const expenses = formatCategoryData(expenseData)
  const income = formatCategoryData(incomeData)
  
  const expenseTotals = calculateTotal(expenseData)
  const incomeTotals = calculateTotal(incomeData)
  
  const expenseTotal = ctx.i18n.t('reports.totalExpense', { 
    total: formatTotal(expenseTotals) || '0' 
  })
  const incomeTotal = ctx.i18n.t('reports.totalIncome', { 
    total: formatTotal(incomeTotals) || '0' 
  })
  
  // Calculate cashflow per currency
  const cashflowByCurrency: { [currency: string]: number } = {}
  
  // Add income
  Object.keys(incomeTotals).forEach(currency => {
    cashflowByCurrency[currency] = incomeTotals[currency]
  })
  
  // Subtract expenses
  Object.keys(expenseTotals).forEach(currency => {
    if (cashflowByCurrency[currency]) {
      cashflowByCurrency[currency] -= expenseTotals[currency]
    } else {
      cashflowByCurrency[currency] = -expenseTotals[currency]
    }
  })
  
  const cashflowStr = Object.keys(cashflowByCurrency)
    .map(currency => {
      const amount = cashflowByCurrency[currency]
      const sign = amount >= 0 ? '+' : ''
      return `${sign}${amount.toFixed(2)} ${currency}`
    })
    .join(', ') || '0'
  
  const cashflow = ctx.i18n.t('reports.cashflow', { amount: cashflowStr })
  
  log('expenses: %O', expenses)
  log('income: %O', income)
  log('expenseTotal: %O', expenseTotal)
  log('incomeTotal: %O', incomeTotal)
  log('cashflow: %O', cashflow)
  
  return ctx.i18n.t('reports.monthly', {
    month: dayjs(month).format('MMMM YYYY'),
    expenses: expenses || ctx.i18n.t('reports.noData'),
    income: income || ctx.i18n.t('reports.noData'),
    expenseTotal,
    incomeTotal,
    cashflow
  })
}

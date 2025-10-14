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

type ReportType = 'monthly' | 'yearly'

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

    let period: string
    let reportType: ReportType

    // Check if it is a callback query or a regular message
    if (isRegularMessage) {
      period = dayjs().format('YYYY-MM')
      reportType = 'monthly'
    } else {
      await ctx.answerCallbackQuery()
      period = ctx.match![1]
      reportType = ctx.match![2] as ReportType
    }
    log('period: %O, reportType: %O', period, reportType)

    let startDate: string
    let endDate: string

    if (reportType === 'yearly') {
      startDate = dayjs(period).startOf('year').format('YYYY-MM-DD')
      endDate = dayjs(period).endOf('year').format('YYYY-MM-DD')
    } else {
      startDate = dayjs(period).startOf('month').format('YYYY-MM-DD')
      endDate = dayjs(period).endOf('month').format('YYYY-MM-DD')
    }
    log('startDate: %O, endDate: %O', startDate, endDate)

    // Fetch expense and income data in parallel
    const [expenseData, incomeData] = await Promise.all([
      firefly(userSettings).Insight.insightExpenseCategory(startDate, endDate),
      firefly(userSettings).Insight.insightIncomeCategory(startDate, endDate)
    ])

    log('expenseData: %O', expenseData.data)
    log('incomeData: %O', incomeData.data)

    const keyboard = createReportNavigationKeyboard(ctx, period, reportType)
    const text = formatReportMessage(ctx, period, reportType, expenseData.data, incomeData.data)

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
  ctx: MyContext, currentPeriod: string, reportType: ReportType
): InlineKeyboard {
  const log = debug.extend('createReportNavigationKeyboard')

  const keyboard = new InlineKeyboard()

  if (reportType === 'yearly') {
    const prevYear = dayjs(currentPeriod).subtract(1, 'year')
    const prevYearName = prevYear.format('YYYY')
    const nextYear = dayjs(currentPeriod).add(1, 'year')
    const nextYearName = nextYear.format('YYYY')

    log('prevYearName: %O, nextYearName: %O', prevYearName, nextYearName)

    keyboard
      .text(
        `<< ${prevYearName}`,
        mapper.list.template({ period: prevYear.format('YYYY-MM'), type: 'yearly' })
      )
      .text(
        `${nextYearName} >>`,
        mapper.list.template({ period: nextYear.format('YYYY-MM'), type: 'yearly' })
      ).row()
      .text(
        ctx.i18n.t('labels.SHOW_MONTHLY'),
        mapper.list.template({ period: currentPeriod, type: 'monthly' })
      ).row()
  } else {
    const prevMonth = dayjs(currentPeriod).subtract(1, 'month')
    const prevMonthName = prevMonth.format('MMM YYYY')
    const nextMonth = dayjs(currentPeriod).add(1, 'month')
    const nextMonthName = nextMonth.format('MMM YYYY')

    log('prevMonthName: %O, nextMonthName: %O', prevMonthName, nextMonthName)

    keyboard
      .text(
        `<< ${prevMonthName}`,
        mapper.list.template({ period: prevMonth.format('YYYY-MM'), type: 'monthly' })
      )
      .text(
        `${nextMonthName} >>`,
        mapper.list.template({ period: nextMonth.format('YYYY-MM'), type: 'monthly' })
      ).row()
      .text(
        ctx.i18n.t('labels.SHOW_YEARLY'),
        mapper.list.template({ period: currentPeriod, type: 'yearly' })
      ).row()
  }

  keyboard.text(ctx.i18n.t('labels.DONE'), mapper.close.template())

  return keyboard
}

function formatCategoryData(entries: InsightGroupEntry[]) {
  const log = debug.extend('formatCategoryData')

  if (entries.length === 0) return ''

  const data = entries
    .sort((a, b) => {
      const amountA = Math.abs(a.difference_float || 0)
      const amountB = Math.abs(b.difference_float || 0)
      return amountB - amountA
    })
    .map(entry => {
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
  period: string,
  reportType: ReportType,
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

  const periodDisplay = reportType === 'yearly'
    ? dayjs(period).format('YYYY')
    : dayjs(period).format('MMMM YYYY')

  const translationKey = reportType === 'yearly' ? 'reports.yearly' : 'reports.monthly'

  return ctx.i18n.t(translationKey, {
    period: periodDisplay,
    expenses: expenses || ctx.i18n.t('reports.noData'),
    income: income || ctx.i18n.t('reports.noData'),
    expenseTotal,
    incomeTotal,
    cashflow
  })
}

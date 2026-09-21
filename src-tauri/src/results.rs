//! One bounded drain over a connection's result stream.
//!
//! Export, backup and the Slack bot each used to open a read with `run_single`, reject
//! a non-row outcome, and loop `fetch_page` until `done`, with their own budget
//! accounting (or none). `ResultStream` owns that loop: the first page the query
//! returned, every later page, the "exhausted" verdict, and the memory bound, with
//! `TextBudget` (db.rs) as the only accountant. Callers keep only their sink.
//!
//! The stream holds the backend mutably for its lifetime, so nothing else can touch
//! the cursor underneath it; drop it (or let it fall out of scope) before the caller
//! rolls the cursor back.

use crate::db::{AppError, QueryOutcome, TextBudget, TextLimits};
use crate::driver::Backend;

pub(crate) type Row = Vec<Option<String>>;

/// How the stream's memory is bounded.
#[derive(Clone, Copy)]
pub(crate) enum Bound {
    /// Each page is checked on its own: the rows go to a sink and are not retained
    /// (export, backup). A belt over the driver's own per-page collection limits.
    PerPage(TextLimits),
    /// Everything read so far is accounted, charging container overhead per row and
    /// cell as well as text bytes: the result is retained in memory (Slack).
    Retained(TextLimits),
}

/// Which run path opens the read.
#[derive(Clone, Copy)]
pub(crate) enum Mode {
    Normal,
    /// `Backend::run_single_read_only`: refuses a backend that is not read-only.
    ReadOnlyIsolated,
}

pub(crate) struct ResultStream<'a> {
    backend: &'a mut Backend,
    page: u32,
    bound: Bound,
    retained: Option<TextBudget>,
    columns: Vec<String>,
    first: Option<Vec<Row>>,
    done: bool,
}

impl<'a> ResultStream<'a> {
    /// Run `sql` as a cursorable read. `Ok(None)` when it produced no result set.
    pub(crate) async fn open(
        backend: &'a mut Backend,
        sql: &str,
        page: u32,
        bound: Bound,
        mode: Mode,
    ) -> Result<Option<ResultStream<'a>>, AppError> {
        let out = match mode {
            Mode::Normal => backend.run_single(sql, page, true).await?,
            Mode::ReadOnlyIsolated => backend.run_single_read_only(sql, page, true).await?,
        };
        let (columns, rows, done) = match out {
            QueryOutcome::Rows {
                columns,
                rows,
                done,
                ..
            } => (columns, rows, done),
            QueryOutcome::Exec { .. } => return Ok(None),
        };
        let retained = match bound {
            Bound::PerPage(_) => None,
            Bound::Retained(limits) => Some(TextBudget::with_overhead(&columns, limits)?),
        };
        let mut stream = Self {
            backend,
            page,
            bound,
            retained,
            columns,
            first: None,
            done,
        };
        stream.account(&rows)?;
        stream.first = Some(rows);
        Ok(Some(stream))
    }

    fn account(&mut self, rows: &[Row]) -> Result<(), AppError> {
        match (&self.bound, self.retained.as_mut()) {
            (Bound::PerPage(limits), _) => {
                let mut budget = TextBudget::new(&self.columns, *limits)?;
                for row in rows {
                    budget.add_row(row)?;
                }
                Ok(())
            }
            (Bound::Retained(_), Some(budget)) => {
                for row in rows {
                    budget.add_row(row)?;
                }
                Ok(())
            }
            (Bound::Retained(_), None) => unreachable!("retained bound always has a budget"),
        }
    }

    pub(crate) fn columns(&self) -> &[String] {
        &self.columns
    }

    /// The next page of rows, or `None` once the stream is exhausted. The first call
    /// returns the page the query itself produced; later calls fetch through the cursor.
    pub(crate) async fn next_page(&mut self) -> Result<Option<Vec<Row>>, AppError> {
        if let Some(first) = self.first.take() {
            return Ok(Some(first));
        }
        if self.done {
            return Ok(None);
        }
        let page = self.backend.fetch_page(self.page).await?;
        self.done = page.done;
        self.account(&page.rows)?;
        Ok(Some(page.rows))
    }
}

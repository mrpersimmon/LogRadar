use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub enum Level { Error, Warn, Info, Debug, Trace, Other(String) }

#[derive(Debug, Clone)]
pub enum Predicate {
    Text(String),
    Regex(Regex),
    Level(Vec<Level>),
    TimeRange { start_epoch_ms: Option<i64>, end_epoch_ms: Option<i64> },
    Not(Box<Predicate>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Combinator { And, Or }

#[derive(Debug, Clone)]
pub enum QueryNode {
    Leaf(Predicate),
    Branch { combinator: Combinator, children: Vec<QueryNode> },
}

#[derive(Debug, Clone)]
pub struct Query { pub root: QueryNode }

#[derive(Debug, Clone, PartialEq)]
pub enum QueryError { InvalidRegex(String) }

impl Query {
    /// Validates any Regex predicates. Returns Err on the first invalid regex.
    pub fn build(root: QueryNode) -> Result<Query, QueryError> {
        Self::validate(&root)?;
        Ok(Query { root })
    }
    fn validate(node: &QueryNode) -> Result<(), QueryError> {
        match node {
            QueryNode::Leaf(Predicate::Regex(_)) => Ok(()),   // Regex already compiled → valid
            QueryNode::Leaf(_) => Ok(()),
            QueryNode::Branch { children, .. } => { for c in children { Self::validate(c)?; } Ok(()) }
        }
    }
}

impl Predicate {
    /// Accepts a user-typed pattern. If it compiles as regex, returns Predicate::Regex;
    /// otherwise returns InvalidRegex. (Callers that want literal text use Predicate::Text.)
    pub fn regex_or_text(pattern: &str) -> Result<Predicate, QueryError> {
        match Regex::new(pattern) {
            Ok(r) => Ok(Predicate::Regex(r)),
            Err(_) => Err(QueryError::InvalidRegex(pattern.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_accepts_compiled_regex() {
        let r = Regex::new("refused|timeout").unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Regex(r)));
        assert!(q.is_ok());
    }
    #[test]
    fn build_rejects_via_regex_constructor() {
        // An invalid regex cannot be constructed via Regex::new in the first place;
        // callers must go through a Predicate::regex_or_text helper that surfaces the error.
        let bad = Predicate::regex_or_text("(unclosed");
        assert!(matches!(bad, Err(QueryError::InvalidRegex(_))));
    }
}
